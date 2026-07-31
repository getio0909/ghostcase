import { describe, expect, it } from 'vitest';

import {
  GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
  GHOSTCASE_EVIDENCE_SCHEMA,
  EvidenceValidationError,
  validateEvidence,
} from '../../src/evidence/model.js';
import {
  createReport,
  GHOSTCASE_REPORT_SCHEMA,
  type GhostCaseReport,
} from '../../src/report/index.js';

const digest = 'a'.repeat(64);

function cleanReport(): GhostCaseReport {
  return createReport({
    exitCode: 0,
    experiments: { limit: 4, used: 4 },
    schema: GHOSTCASE_REPORT_SCHEMA,
    status: 'clean',
    suite: { id: 'evidence-suite', sourceSha256: digest },
    toolVersion: '0.1.0',
    victims: [
      {
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'b'.repeat(64),
        },
        id: 'victim',
        minimalChain: [],
        minimality: 'not_applicable',
        shared: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'b'.repeat(64),
        },
        stateChanges: [],
        verdict: 'CLEAN',
      },
    ],
  });
}

function validEvidence(): unknown {
  return {
    report: cleanReport(),
    schema: GHOSTCASE_EVIDENCE_SCHEMA,
    suite: {
      executionDependencies: {
        boundSuiteFiles: 2,
        schema: GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
        sha256: 'c'.repeat(64),
        unboundDynamicPathReferences: 2,
        unboundDynamicStdinFiles: 1,
        unboundLookupPrograms: 3,
        unboundSuitePathReferences: 1,
      },
      locator: '../suite/ghostcase.json',
      preparedSeedSha256: 'd'.repeat(64),
      sourceSha256: digest,
    },
    toolVersion: '0.1.0',
  };
}

describe('validateEvidence', () => {
  it('detaches, validates, and deeply freezes a complete evidence document', () => {
    const input = validEvidence();
    const evidence = validateEvidence(input);

    expect(evidence).toEqual(input);
    expect(evidence).not.toBe(input);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.suite)).toBe(true);
    expect(Object.isFrozen(evidence.report)).toBe(true);
  });

  it.each([
    { locator: '/tmp/ghostcase.json', label: 'absolute POSIX' },
    { locator: 'C:/suite/ghostcase.json', label: 'drive-qualified' },
    { locator: '..\\suite\\ghostcase.json', label: 'backslash' },
    { locator: '../suite/\0ghostcase.json', label: 'NUL' },
    { locator: './ghostcase.json', label: 'redundant segment' },
    { locator: 'suite/../ghostcase.json', label: 'reducible parent segment' },
    { locator: '../', label: 'directory-like' },
  ])('rejects a $label suite locator', ({ locator }) => {
    const input = validEvidence() as {
      suite: { locator: string; sourceSha256: string };
    };
    input.suite.locator = locator;

    expect(() => validateEvidence(input)).toThrow(EvidenceValidationError);
  });

  it('accepts parent segments without allowing an absolute locator', () => {
    const input = validEvidence() as {
      suite: { locator: string; sourceSha256: string };
    };
    input.suite.locator = '../../project/ghostcase.json';

    expect(validateEvidence(input).suite.locator).toBe('../../project/ghostcase.json');
  });

  it('rejects unknown fields at every evidence-owned level', () => {
    const root = { ...(validEvidence() as object), environment: {} };
    const nested = validEvidence() as {
      suite: { locator: string; sourceSha256: string; stdout?: string };
    };
    nested.suite.stdout = 'private';

    expect(() => validateEvidence(root)).toThrow(/unknown/iu);
    expect(() => validateEvidence(nested)).toThrow(/unknown/iu);
  });

  it('rejects legacy v1 evidence that lacks replay input bindings', () => {
    const input = validEvidence() as {
      schema: string;
      suite: {
        executionDependencies?: unknown;
        locator: string;
        preparedSeedSha256?: string;
        sourceSha256: string;
      };
    };
    input.schema = 'ghostcase/evidence/v1';
    delete input.suite.executionDependencies;
    delete input.suite.preparedSeedSha256;

    expect(() => validateEvidence(input)).toThrow(/ghostcase\/evidence\/v2/iu);
  });

  it('rejects malformed seed and direct-dependency bindings', () => {
    const invalidSeed = validEvidence() as {
      suite: { preparedSeedSha256: string };
    };
    invalidSeed.suite.preparedSeedSha256 = 'D'.repeat(64);
    const invalidCoverage = validEvidence() as {
      suite: { executionDependencies: { unboundLookupPrograms: number } };
    };
    invalidCoverage.suite.executionDependencies.unboundLookupPrograms = -1;

    expect(() => validateEvidence(invalidSeed)).toThrow(/preparedSeedSha256/iu);
    expect(() => validateEvidence(invalidCoverage)).toThrow(/unboundLookupPrograms/iu);
  });

  it('rejects a report, source digest, or tool version that disagrees with the envelope', () => {
    const sourceMismatch = validEvidence() as {
      suite: { locator: string; sourceSha256: string };
    };
    sourceMismatch.suite.sourceSha256 = 'c'.repeat(64);
    const versionMismatch = validEvidence() as { toolVersion: string };
    versionMismatch.toolVersion = '0.2.0';

    expect(() => validateEvidence(sourceMismatch)).toThrow(/source/iu);
    expect(() => validateEvidence(versionMismatch)).toThrow(/version/iu);
  });
});
