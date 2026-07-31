import { describe, expect, it } from 'vitest';

import {
  createReport,
  ReportValidationError,
  summarizeArm,
  validateReport,
  type GhostCaseReportInput,
  type GhostCaseVictimReportInput,
} from '../../src/report/model.js';

const digest = (character: string): string => character.repeat(64);

function reportInput(): GhostCaseReportInput {
  return {
    schema: 'ghostcase/report/v1',
    toolVersion: '0.1.0',
    suite: {
      id: 'memory-suite',
      sourceSha256: digest('a'),
    },
    status: 'findings',
    exitCode: 1,
    experiments: {
      used: 7,
      limit: 32,
    },
    victims: [
      {
        id: 'victim',
        verdict: 'POLLUTION',
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: digest('b'),
        },
        shared: {
          kind: 'stable',
          oracleOutcome: 'fail',
          signatureSha256: digest('c'),
        },
        minimalChain: ['polluter'],
        minimality: 'proven',
        stateChanges: [
          {
            alias: 'memory',
            subjectId: digest('d'),
            kind: 'modified',
            size: 23,
            digest: digest('e'),
          },
        ],
      },
    ],
  };
}

describe('createReport', () => {
  it('clones, sorts, and deeply freezes a valid report', () => {
    const input = reportInput();
    const victim = input.victims[0];
    if (victim === undefined) {
      throw new Error('fixture victim is missing');
    }
    const changes = victim.stateChanges as (typeof victim.stateChanges)[number][];
    changes.push({
      alias: 'a-cache',
      subjectId: digest('f'),
      kind: 'added',
    });

    const report = createReport(input);
    changes.length = 0;

    expect(report.victims[0]?.stateChanges.map((change) => change.alias)).toEqual([
      'a-cache',
      'memory',
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.victims)).toBe(true);
    expect(Object.isFrozen(report.victims[0]?.stateChanges)).toBe(true);
  });

  it('rejects unknown fields, malformed digests, and aggregate status mismatches', () => {
    expect(() =>
      validateReport({
        ...reportInput(),
        unexpected: true,
      }),
    ).toThrow(ReportValidationError);

    expect(() =>
      createReport({
        ...reportInput(),
        suite: { id: 'memory-suite', sourceSha256: 'not-a-digest' },
      }),
    ).toThrow(/sourceSha256/u);

    expect(() =>
      createReport({
        ...reportInput(),
        status: 'clean',
        exitCode: 0,
      }),
    ).toThrow(/status/u);
  });

  it('uses exit code 3 for inconclusive and non-reproducible runtime evidence', () => {
    const incompleteVictim: GhostCaseVictimReportInput = {
      id: 'flaky',
      verdict: 'NON_REPRODUCIBLE',
      fresh: { kind: 'non_reproducible' },
      shared: {
        kind: 'stable',
        oracleOutcome: 'pass',
        signatureSha256: digest('b'),
      },
      minimalChain: [],
      minimality: 'not_applicable',
      stateChanges: [],
    };
    const base = reportInput();
    const incomplete: GhostCaseReportInput = {
      ...base,
      victims: [incompleteVictim],
      status: 'inconclusive',
      exitCode: 3,
    };

    expect(createReport(incomplete).exitCode).toBe(3);
    expect(() => createReport({ ...incomplete, exitCode: 2 })).toThrow(/exitCode/u);

    const findingVictim = base.victims[0];
    if (findingVictim === undefined) {
      throw new Error('fixture finding victim is missing');
    }
    const mixed = createReport({
      ...base,
      victims: [findingVictim, incompleteVictim],
      status: 'inconclusive',
      exitCode: 3,
    });
    expect(mixed.status).toBe('inconclusive');
  });

  it('rejects absolute paths and credential-like text in reasons', () => {
    const victim = reportInput().victims[0];
    if (victim === undefined) {
      throw new Error('fixture victim is missing');
    }

    expect(() =>
      createReport({
        ...reportInput(),
        victims: [{ ...victim, reason: 'failed in C:\\Users\\alice\\agent' }],
      }),
    ).toThrow(/safe diagnostic/u);

    expect(() =>
      createReport({
        ...reportInput(),
        victims: [{ ...victim, reason: 'OPENAI_API_KEY=ordinary-looking-value' }],
      }),
    ).toThrow(/safe diagnostic/u);
  });
});

describe('summarizeArm', () => {
  it('hashes stable signatures and omits raw diagnostic details', () => {
    const signature = 'stdout=C:\\Users\\alice\\private; OPENAI_API_KEY=sk-do-not-leak';

    const summary = summarizeArm({
      kind: 'stable',
      oracleOutcome: 'pass',
      signature,
    });

    expect(summary.kind).toBe('stable');
    if (summary.kind !== 'stable') {
      throw new Error('expected a stable summary');
    }
    expect(summary.oracleOutcome).toBe('pass');
    expect(summary.signatureSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(summary)).not.toContain(signature);

    expect(
      summarizeArm({
        kind: 'harness_error',
        reason: 'C:\\private\\harness.log',
      }),
    ).toEqual({ kind: 'harness_error' });
  });
});
