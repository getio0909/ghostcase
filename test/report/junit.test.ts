import { describe, expect, it } from 'vitest';

import { formatJunitReport } from '../../src/report/junit.js';
import {
  createReport,
  type GhostCaseReportInput,
  type GhostCaseVictimReportInput,
  type ReportVerdict,
} from '../../src/report/model.js';

const digest = (character: string): string => character.repeat(64);

function victim(id: string, verdict: ReportVerdict, reason?: string): GhostCaseVictimReportInput {
  const isFinding =
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
                signatureSha256: isFinding ? digest('b') : digest('a'),
              },
    minimalChain: isFinding ? ['polluter'] : [],
    minimality: isFinding ? 'proven' : 'not_applicable',
    stateChanges: [],
    ...(reason === undefined ? {} : { reason }),
  };
}

function mixedReport(): GhostCaseReportInput {
  return {
    schema: 'ghostcase/report/v1',
    toolVersion: '0.1.0',
    suite: { id: 'mixed-suite', sourceSha256: digest('c') },
    status: 'harness_error',
    exitCode: 3,
    experiments: { used: 31, limit: 64 },
    victims: [
      victim('clean', 'CLEAN'),
      victim('pollution', 'POLLUTION', 'unsafe <state> & "quoted" and \'single\''),
      victim('dependency', 'HIDDEN_DEPENDENCY'),
      victim('shift', 'OUTCOME_SHIFT'),
      victim('incomplete', 'INCONCLUSIVE'),
      victim('flaky', 'NON_REPRODUCIBLE'),
      victim('broken', 'HARNESS_ERROR'),
    ],
  };
}

describe('formatJunitReport', () => {
  it('maps verdicts to failures, errors, skipped cases, and passes', () => {
    const output = formatJunitReport(createReport(mixedReport()));

    expect(output).toContain(
      '<testsuites name="GhostCase" tests="7" failures="3" errors="1" skipped="2">',
    );
    expect(output.match(/<failure /gu)).toHaveLength(3);
    expect(output.match(/<error /gu)).toHaveLength(1);
    expect(output.match(/<skipped /gu)).toHaveLength(2);
    expect(output).toContain(
      'unsafe &lt;state&gt; &amp; &quot;quoted&quot; and &apos;single&apos;',
    );
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });

  it('renders a clean suite without failure elements', () => {
    const mixed = mixedReport();

    const output = formatJunitReport(
      createReport({
        ...mixed,
        victims: [victim('clean', 'CLEAN')],
        status: 'clean',
        exitCode: 0,
      }),
    );

    expect(output).toContain('failures="0" errors="0" skipped="0"');
    expect(output).not.toContain('<failure ');
    expect(output).not.toContain('<error ');
    expect(output).not.toContain('<skipped ');
  });
});
