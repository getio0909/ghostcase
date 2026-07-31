import { describe, expect, it } from 'vitest';

import { createReport, type GhostCaseReportInput } from '../../src/report/model.js';
import { formatJsonReport } from '../../src/report/json.js';

const digest = (character: string): string => character.repeat(64);

function cleanReport(): GhostCaseReportInput {
  return {
    schema: 'ghostcase/report/v1',
    toolVersion: '0.1.0',
    suite: { id: 'clean-suite', sourceSha256: digest('a') },
    status: 'clean',
    exitCode: 0,
    experiments: { used: 2, limit: 16 },
    victims: [
      {
        id: 'victim',
        verdict: 'CLEAN',
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: digest('b'),
        },
        shared: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: digest('b'),
        },
        minimalChain: [],
        minimality: 'not_applicable',
        stateChanges: [],
      },
    ],
  };
}

describe('formatJsonReport', () => {
  it('emits canonical JSON with exactly one trailing newline', () => {
    const output = formatJsonReport(createReport(cleanReport()));

    expect(output.startsWith('{"exitCode":0,"experiments":')).toBe(true);
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(output)).toMatchObject({
      schema: 'ghostcase/report/v1',
      status: 'clean',
    });
  });

  it('is byte-for-byte deterministic', () => {
    const input = cleanReport();

    expect(formatJsonReport(createReport(input))).toBe(formatJsonReport(createReport(input)));
  });
});
