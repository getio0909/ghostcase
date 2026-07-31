import { describe, expect, it } from 'vitest';

import { formatReport } from '../../src/report/index.js';
import {
  createReport,
  summarizeArm,
  type GhostCaseReportInput,
  type GhostCaseVictimReportInput,
} from '../../src/report/model.js';
import { formatSarifReport } from '../../src/report/sarif.js';

const digest = (character: string): string => character.repeat(64);

function victim(
  id: string,
  verdict: GhostCaseVictimReportInput['verdict'],
): GhostCaseVictimReportInput {
  const finding =
    verdict === 'POLLUTION' || verdict === 'HIDDEN_DEPENDENCY' || verdict === 'OUTCOME_SHIFT';
  return {
    id,
    verdict,
    fresh: {
      kind: 'stable',
      oracleOutcome: verdict === 'HIDDEN_DEPENDENCY' ? 'fail' : 'pass',
      signatureSha256: digest('a'),
    },
    shared:
      verdict === 'HARNESS_ERROR'
        ? { kind: 'harness_error' }
        : verdict === 'INCONCLUSIVE'
          ? { kind: 'inconclusive' }
          : verdict === 'NON_REPRODUCIBLE'
            ? { kind: 'non_reproducible' }
            : {
                kind: 'stable',
                oracleOutcome: verdict === 'POLLUTION' ? 'fail' : 'pass',
                signatureSha256: finding ? digest('b') : digest('a'),
              },
    minimalChain: finding ? ['polluter'] : [],
    minimality: finding ? 'proven' : 'not_applicable',
    stateChanges: [],
  };
}

function reportInput(): GhostCaseReportInput {
  return {
    schema: 'ghostcase/report/v1',
    toolVersion: '0.1.0',
    suite: { id: 'mixed-suite', sourceSha256: digest('c') },
    status: 'harness_error',
    exitCode: 3,
    experiments: { used: 18, limit: 64 },
    victims: [
      victim('clean', 'CLEAN'),
      victim('pollution', 'POLLUTION'),
      victim('dependency', 'HIDDEN_DEPENDENCY'),
      victim('shift', 'OUTCOME_SHIFT'),
      victim('incomplete', 'INCONCLUSIVE'),
      victim('flaky', 'NON_REPRODUCIBLE'),
      victim('broken', 'HARNESS_ERROR'),
    ],
  };
}

describe('formatSarifReport', () => {
  it('emits SARIF 2.1.0 findings and diagnostics without clean results', () => {
    const parsed = JSON.parse(formatSarifReport(createReport(reportInput()))) as {
      $schema: string;
      runs: {
        invocations: { executionSuccessful: boolean; exitCode: number }[];
        results: { kind: string; ruleId: string }[];
      }[];
      version: string;
    };
    const run = parsed.runs[0];

    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toBe(
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json',
    );
    expect(run?.results.map((result) => result.ruleId)).toEqual([
      'GHOSTCASE_POLLUTION',
      'GHOSTCASE_HIDDEN_DEPENDENCY',
      'GHOSTCASE_OUTCOME_SHIFT',
      'GHOSTCASE_INCONCLUSIVE',
      'GHOSTCASE_NON_REPRODUCIBLE',
      'GHOSTCASE_HARNESS_ERROR',
    ]);
    expect(run?.results.map((result) => result.kind)).toEqual([
      'fail',
      'fail',
      'fail',
      'review',
      'review',
      'fail',
    ]);
    expect(run?.invocations).toEqual([{ executionSuccessful: false, exitCode: 3 }]);
  });

  it('produces no results for a clean report', () => {
    const input = reportInput();

    const parsed = JSON.parse(
      formatSarifReport(
        createReport({
          ...input,
          victims: [victim('clean', 'CLEAN')],
          status: 'clean',
          exitCode: 0,
        }),
      ),
    ) as {
      runs: { results: unknown[] }[];
    };

    expect(parsed.runs[0]?.results).toEqual([]);
  });
});

describe('formatReport', () => {
  it.each(['json', 'human', 'junit', 'sarif'] as const)(
    'dispatches deterministic %s output with one trailing newline',
    (format) => {
      const input = reportInput();
      const secret = 'C:\\Users\\alice\\private OPENAI_API_KEY=sk-super-secret';
      const safeSummary = summarizeArm({
        kind: 'stable',
        oracleOutcome: 'pass',
        signature: secret,
      });
      const report = createReport({
        ...input,
        victims: input.victims.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                fresh: safeSummary,
                shared: safeSummary,
              }
            : entry,
        ),
      });

      const first = formatReport(report, format);
      const second = formatReport(report, format);

      expect(first).toBe(second);
      expect(first.endsWith('\n')).toBe(true);
      expect(first.endsWith('\n\n')).toBe(false);
      expect(first).not.toContain(secret);
      expect(first).not.toContain('OPENAI_API_KEY');
      expect(first).not.toContain('sk-super-secret');
      expect(first).not.toContain('C:\\Users');
    },
  );
});
