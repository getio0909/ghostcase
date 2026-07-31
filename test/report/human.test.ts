import { describe, expect, it } from 'vitest';

import { formatHumanReport } from '../../src/report/human.js';
import { createReport, type GhostCaseReportInput } from '../../src/report/model.js';

const digest = (character: string): string => character.repeat(64);

function findingReport(): GhostCaseReportInput {
  return {
    schema: 'ghostcase/report/v1',
    toolVersion: '0.1.0',
    suite: { id: 'memory-suite', sourceSha256: digest('a') },
    status: 'findings',
    exitCode: 1,
    experiments: { used: 9, limit: 64 },
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
        minimalChain: ['setup', 'polluter'],
        minimality: 'proven',
        stateChanges: [
          {
            alias: 'memory',
            subjectId: digest('d'),
            kind: 'modified',
            size: 42,
            digest: digest('e'),
          },
        ],
        reason: 'oracle changed <pass> & "fail"',
      },
    ],
  };
}

describe('formatHumanReport', () => {
  it('renders a concise finding with safe evidence only', () => {
    const output = formatHumanReport(createReport(findingReport()));

    expect(output).toContain('GhostCase 0.1.0 · memory-suite · FINDINGS');
    expect(output).toContain('victim: POLLUTION');
    expect(output).toContain('setup → polluter');
    expect(output).toContain('memory/modified');
    expect(output).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(output).not.toContain('stdout');
    expect(output).not.toContain('env');
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });

  it('is deterministic', () => {
    const report = createReport(findingReport());

    expect(formatHumanReport(report)).toBe(formatHumanReport(report));
  });
});
