import { describe, expect, it } from 'vitest';

import type { CaseSpec, PlatformName } from '../../src/domain/model.js';
import {
  diagnoseCases,
  type DiagnoseCasesOptions,
  type DiagnosisExecutionResult,
  type DiagnosisReport,
  type VictimDiagnosis,
} from '../../src/experiment/diagnose.js';

function makeCase(id: string, platforms: readonly PlatformName[] = ['linux', 'win32']): CaseSpec {
  return {
    description: `${id} fixture`,
    id,
    platforms: [...platforms],
    run: {
      argv: [],
      env: { set: {}, unset: [] },
    },
    setup: [],
    tags: [],
  };
}

function valid<E>(
  oracleOutcome: 'fail' | 'pass',
  semanticSignature: string,
  evidence?: E,
): DiagnosisExecutionResult<E> {
  return evidence === undefined
    ? { kind: 'valid', oracleOutcome, semanticSignature }
    : { evidence, kind: 'valid', oracleOutcome, semanticSignature };
}

function commonOptions<E>(
  cases: readonly CaseSpec[],
  execute: (
    chain: readonly CaseSpec[],
    victim: CaseSpec,
    attemptIndex: number,
  ) => DiagnosisExecutionResult<E> | PromiseLike<DiagnosisExecutionResult<E>>,
): DiagnoseCasesOptions<E> {
  const victim = cases.at(-1);
  if (victim === undefined) {
    throw new RangeError('A fixture must contain at least one case');
  }
  return {
    currentPlatform: 'linux' as const,
    execute,
    maxChainLength: 16,
    maxExperiments: 100,
    orderedCases: cases,
    repetitions: 2,
    victims: [victim],
  };
}

function onlyVictim<E>(report: DiagnosisReport<E>): VictimDiagnosis<E> {
  const victim = report.victims[0];
  if (victim === undefined) {
    throw new RangeError('Expected exactly one victim diagnosis');
  }
  return victim;
}

describe('diagnoseCases verdicts', () => {
  it.each([
    {
      expected: 'POLLUTION',
      fresh: ['pass', 'fresh-pass'],
      shared: ['fail', 'shared-fail'],
    },
    {
      expected: 'HIDDEN_DEPENDENCY',
      fresh: ['fail', 'fresh-fail'],
      shared: ['pass', 'shared-pass'],
    },
    {
      expected: 'OUTCOME_SHIFT',
      fresh: ['pass', 'fresh-pass'],
      shared: ['pass', 'different-pass'],
    },
    {
      expected: 'CLEAN',
      fresh: ['pass', 'same-pass'],
      shared: ['pass', 'same-pass'],
    },
  ] as const)(
    'classifies a stable predecessor as $expected',
    async ({ expected, fresh, shared }) => {
      const predecessor = makeCase('predecessor');
      const victim = makeCase('victim');

      const report = await diagnoseCases({
        ...commonOptions([predecessor, victim], (chain) => {
          const fixture = chain.length === 0 ? fresh : shared;
          return valid(fixture[0], fixture[1], { chain: chain.map(({ id }) => id) });
        }),
      });

      const finding = onlyVictim(report);
      expect(finding.verdict).toBe(expected);
      expect(finding.fresh).toMatchObject({
        kind: 'stable',
        oracleOutcome: fresh[0],
        signature: fresh[1],
      });
      expect(finding.shared).toMatchObject({
        kind: 'stable',
        oracleOutcome: shared[0],
        signature: shared[1],
      });
      expect(finding.minimalChainIds).toEqual(expected === 'CLEAN' ? [] : ['predecessor']);
    },
  );

  it('reports non-reproducible fresh behavior without searching predecessors', async () => {
    const predecessor = makeCase('predecessor');
    const victim = makeCase('victim');
    let executions = 0;

    const report = await diagnoseCases({
      ...commonOptions([predecessor, victim], (_chain, _victim, attemptIndex) => {
        executions += 1;
        return valid('pass', attemptIndex === 0 ? 'first' : 'second');
      }),
      repetitions: 3,
    });

    expect(report.victims[0]).toMatchObject({
      ddmin: null,
      minimalChainIds: [],
      verdict: 'NON_REPRODUCIBLE',
    });
    expect(executions).toBe(2);
  });

  it('turns exclusively invalid attempts into a safe harness error', async () => {
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([victim], () => ({
        code: 'RESET_FAILED',
        kind: 'invalid',
        reason: 'reset command failed',
      })),
    });

    expect(report.victims[0]).toMatchObject({
      fresh: {
        kind: 'harness_error',
        reason: 'RESET_FAILED: reset command failed',
      },
      verdict: 'HARNESS_ERROR',
    });
  });

  it('keeps a partially valid arm inconclusive instead of calling it a harness error', async () => {
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([victim], (_chain, _victim, attemptIndex) =>
        attemptIndex === 0
          ? {
              code: 'TRANSIENT_FAILURE',
              kind: 'invalid',
              reason: 'one transient failure',
            }
          : valid('pass', 'one-valid-run'),
      ),
    });

    expect(onlyVictim(report)).toMatchObject({
      fresh: {
        kind: 'inconclusive',
        reason: 'attempt_limit_after_1_valid_runs',
      },
      verdict: 'INCONCLUSIVE',
    });
  });
});

describe('diagnoseCases search orchestration', () => {
  it('keeps a synergistic two-case pollution witness', async () => {
    const a = makeCase('a');
    const b = makeCase('b');
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([a, b, victim], (chain) => {
        const ids = chain.map(({ id }) => id);
        return ids.includes('a') && ids.includes('b')
          ? valid('fail', 'polluted')
          : valid('pass', 'clean');
      }),
    });

    expect(report.victims[0]).toMatchObject({
      ddmin: {
        candidateIds: ['a', 'b'],
        kind: 'minimized',
        minimality: 'proven',
      },
      minimalChainIds: ['a', 'b'],
      minimality: 'proven',
      prefix: { kind: 'found', prefixLength: 2 },
      verdict: 'POLLUTION',
    });
  });

  it('finds an early pollution prefix even when a later case cleans the state', async () => {
    const polluter = makeCase('polluter');
    const cleaner = makeCase('cleaner');
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([polluter, cleaner, victim], (chain) => {
        const ids = chain.map(({ id }) => id);
        if (ids.includes('cleaner')) {
          return valid('pass', 'clean');
        }
        return ids.includes('polluter') ? valid('fail', 'polluted') : valid('pass', 'clean');
      }),
    });

    expect(report.victims[0]).toMatchObject({
      minimalChainIds: ['polluter'],
      prefix: { exact: true, kind: 'found', prefixLength: 1 },
      verdict: 'POLLUTION',
    });
  });

  it('preserves source order while minimizing away irrelevant cases', async () => {
    const a = makeCase('a');
    const noise = makeCase('noise');
    const c = makeCase('c');
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([a, noise, c, victim], (chain) => {
        const ids = chain.map(({ id }) => id);
        return ids.includes('a') && ids.includes('c') && ids.indexOf('a') < ids.indexOf('c')
          ? valid('fail', 'ordered-pollution')
          : valid('pass', 'clean');
      }),
    });

    expect(report.victims[0]).toMatchObject({
      ddmin: {
        candidateIds: ['a', 'c'],
        candidateOccurrenceIndices: [0, 2],
      },
      minimalChainIds: ['a', 'c'],
      verdict: 'POLLUTION',
    });
  });

  it('returns an inconclusive result when physical-attempt budget expires', async () => {
    const predecessor = makeCase('predecessor');
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([predecessor, victim], (chain) =>
        chain.length === 0 ? valid('pass', 'clean') : valid('fail', 'polluted'),
      ),
      maxExperiments: 3,
    });

    expect(report.experiments).toEqual({ limit: 3, remaining: 0, used: 3 });
    expect(report.victims[0]).toMatchObject({
      minimalChainIds: [],
      minimality: 'not_applicable',
      prefix: { kind: 'inconclusive', reason: 'predicate_unresolved' },
      verdict: 'INCONCLUSIVE',
    });
  });

  it('filters predecessor candidates for the selected platform', async () => {
    const linux = makeCase('linux-only', ['linux']);
    const windows = makeCase('windows-only', ['win32']);
    const victim = makeCase('victim');
    const observedChains: string[][] = [];

    const report = await diagnoseCases({
      ...commonOptions([linux, windows, victim], (chain) => {
        observedChains.push(chain.map(({ id }) => id));
        return valid('pass', 'clean');
      }),
      currentPlatform: 'linux',
    });

    expect(onlyVictim(report).candidateWindow.selectedCandidateIds).toEqual(['linux-only']);
    expect(observedChains.every((chain) => !chain.includes('windows-only'))).toBe(true);
  });

  it('uses a deterministic nearest-predecessor window and reports truncation', async () => {
    const a = makeCase('a');
    const b = makeCase('b');
    const c = makeCase('c');
    const victim = makeCase('victim');

    const report = await diagnoseCases({
      ...commonOptions([a, b, c, victim], () => valid('pass', 'clean')),
      maxChainLength: 2,
    });

    expect(report.victims[0]).toMatchObject({
      candidateWindow: {
        omittedCandidateIds: ['a'],
        originalCandidateCount: 3,
        selectedCandidateIds: ['b', 'c'],
        strategy: 'nearest_predecessors',
        truncated: true,
      },
      diagnosticReasons: ['candidate_window_truncated_to_nearest_predecessors'],
      shared: {
        kind: 'inconclusive',
        reason: 'candidate_window_truncated_before_any_shift_was_found',
      },
      verdict: 'INCONCLUSIVE',
    });
  });

  it('caches victim-chain stability across prefix scan and ddmin without mutating inputs', async () => {
    const predecessor = makeCase('predecessor');
    const victim = makeCase('victim');
    const orderedCases = [predecessor, victim];
    const victims = [victim];
    const inputSnapshot = structuredClone({ orderedCases, victims });
    const calls = new Map<string, number>();

    const report = await diagnoseCases({
      ...commonOptions(orderedCases, (chain) => {
        const key = chain.map(({ id }) => id).join(',');
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return chain.length === 0
          ? valid('pass', 'clean', { source: 'fresh' })
          : valid('fail', 'polluted', { source: 'shared' });
      }),
      victims,
    });

    expect(calls).toEqual(
      new Map([
        ['', 2],
        ['predecessor', 2],
      ]),
    );
    expect({ orderedCases, victims }).toEqual(inputSnapshot);
    expect(Object.isFrozen(predecessor)).toBe(false);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.victims)).toBe(true);
    expect(Object.isFrozen(onlyVictim(report).prefix.observations)).toBe(true);
    expect(Object.isFrozen(onlyVictim(report).representativeEvidence.shared)).toBe(true);
  });
});
