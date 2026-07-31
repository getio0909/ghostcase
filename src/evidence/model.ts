import { posix } from 'node:path';

import { validateReport, type GhostCaseReport } from '../report/index.js';

export const GHOSTCASE_EVIDENCE_SCHEMA = 'ghostcase/evidence/v2' as const;
export const GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA =
  'ghostcase/direct-execution-dependencies/v1' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_DEPENDENCY_REFERENCES = 100_000;
const MAX_LOCATOR_BYTES = 4096;
const MAX_LOCATOR_DEPTH = 64;
const MAX_SEGMENT_BYTES = 255;

/**
 * A deliberately bounded execution-input commitment.
 *
 * The digest covers stable regular non-link suite files referenced as programs, file stdin, or
 * typed argv/environment values. Lookup programs, dynamic state/temp paths, and suite typed paths
 * that are absent, uninspectable, or not regular files remain unbound. Their unique reference
 * counts are retained so evidence never implies recursive, runtime-generated, or host-level
 * completeness.
 */
export interface EvidenceExecutionDependencies {
  readonly boundSuiteFiles: number;
  readonly schema: typeof GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA;
  readonly sha256: string;
  readonly unboundDynamicPathReferences: number;
  readonly unboundDynamicStdinFiles: number;
  readonly unboundLookupPrograms: number;
  readonly unboundSuitePathReferences: number;
}

export interface EvidenceSuiteLocator {
  readonly executionDependencies: EvidenceExecutionDependencies;
  readonly locator: string;
  readonly preparedSeedSha256: string;
  readonly sourceSha256: string;
}

export interface GhostCaseEvidence {
  readonly report: GhostCaseReport;
  readonly schema: typeof GHOSTCASE_EVIDENCE_SCHEMA;
  readonly suite: EvidenceSuiteLocator;
  readonly toolVersion: string;
}

export interface GhostCaseEvidenceInput {
  readonly report: unknown;
  readonly schema: typeof GHOSTCASE_EVIDENCE_SCHEMA;
  readonly suite: {
    readonly executionDependencies: EvidenceExecutionDependencies;
    readonly locator: string;
    readonly preparedSeedSha256: string;
    readonly sourceSha256: string;
  };
  readonly toolVersion: string;
}

export class EvidenceValidationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceValidationError';
  }
}

export function createEvidence(input: GhostCaseEvidenceInput): GhostCaseEvidence {
  return validateEvidence(input);
}

export function validateEvidence(input: unknown): GhostCaseEvidence {
  try {
    const root = readObject(input, '$', ['report', 'schema', 'suite', 'toolVersion']);
    if (root.get('schema') !== GHOSTCASE_EVIDENCE_SCHEMA) {
      throw new EvidenceValidationError(`$.schema must be '${GHOSTCASE_EVIDENCE_SCHEMA}'.`);
    }

    const report = validateReport(root.get('report'));
    const suite = readSuite(root.get('suite'));
    const toolVersion = root.get('toolVersion');
    if (typeof toolVersion !== 'string' || toolVersion !== report.toolVersion) {
      throw new EvidenceValidationError(
        '$.toolVersion must equal the validated report tool version.',
      );
    }
    if (suite.sourceSha256 !== report.suite.sourceSha256) {
      throw new EvidenceValidationError(
        '$.suite.sourceSha256 must equal the validated report source digest.',
      );
    }

    return Object.freeze({
      report,
      schema: GHOSTCASE_EVIDENCE_SCHEMA,
      suite,
      toolVersion,
    });
  } catch (error) {
    if (error instanceof EvidenceValidationError) {
      throw error;
    }
    throw new EvidenceValidationError('Evidence input could not be validated safely.', {
      cause: error,
    });
  }
}

export function validateEvidenceLocator(value: unknown, path = '$.suite.locator'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    Buffer.byteLength(value, 'utf8') > MAX_LOCATOR_BYTES
  ) {
    throw new EvidenceValidationError(`${path} must be a bounded NFC string.`);
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    value.endsWith('/') ||
    posix.normalize(value) !== value ||
    value === '.'
  ) {
    throw new EvidenceValidationError(`${path} must be a portable relative POSIX path.`);
  }

  const segments = value.split('/');
  if (segments.length > MAX_LOCATOR_DEPTH) {
    throw new EvidenceValidationError(
      `${path} exceeds the ${String(MAX_LOCATOR_DEPTH)}-segment limit.`,
    );
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      (segment !== '..' &&
        (/[ .]$/u.test(segment) ||
          containsForbiddenCharacter(segment) ||
          isWindowsDeviceName(segment))) ||
      Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES
    ) {
      throw new EvidenceValidationError(`${path} contains a non-portable path segment.`);
    }
  }
  if (segments.every((segment) => segment === '..')) {
    throw new EvidenceValidationError(`${path} must identify a manifest file.`);
  }
  return value;
}

function readSuite(input: unknown): EvidenceSuiteLocator {
  const suite = readObject(input, '$.suite', [
    'executionDependencies',
    'locator',
    'preparedSeedSha256',
    'sourceSha256',
  ]);
  const sourceSha256 = suite.get('sourceSha256');
  if (typeof sourceSha256 !== 'string' || !SHA256_PATTERN.test(sourceSha256)) {
    throw new EvidenceValidationError('$.suite.sourceSha256 must be a lowercase SHA-256 digest.');
  }
  const preparedSeedSha256 = readDigest(
    suite.get('preparedSeedSha256'),
    '$.suite.preparedSeedSha256',
  );
  return Object.freeze({
    executionDependencies: readExecutionDependencies(suite.get('executionDependencies')),
    locator: validateEvidenceLocator(suite.get('locator')),
    preparedSeedSha256,
    sourceSha256,
  });
}

function readExecutionDependencies(input: unknown): EvidenceExecutionDependencies {
  const dependencies = readObject(input, '$.suite.executionDependencies', [
    'boundSuiteFiles',
    'schema',
    'sha256',
    'unboundDynamicPathReferences',
    'unboundDynamicStdinFiles',
    'unboundLookupPrograms',
    'unboundSuitePathReferences',
  ]);
  if (dependencies.get('schema') !== GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA) {
    throw new EvidenceValidationError(
      `$.suite.executionDependencies.schema must be '${GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA}'.`,
    );
  }
  return Object.freeze({
    boundSuiteFiles: readCount(
      dependencies.get('boundSuiteFiles'),
      '$.suite.executionDependencies.boundSuiteFiles',
    ),
    schema: GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
    sha256: readDigest(dependencies.get('sha256'), '$.suite.executionDependencies.sha256'),
    unboundDynamicPathReferences: readCount(
      dependencies.get('unboundDynamicPathReferences'),
      '$.suite.executionDependencies.unboundDynamicPathReferences',
    ),
    unboundDynamicStdinFiles: readCount(
      dependencies.get('unboundDynamicStdinFiles'),
      '$.suite.executionDependencies.unboundDynamicStdinFiles',
    ),
    unboundLookupPrograms: readCount(
      dependencies.get('unboundLookupPrograms'),
      '$.suite.executionDependencies.unboundLookupPrograms',
    ),
    unboundSuitePathReferences: readCount(
      dependencies.get('unboundSuitePathReferences'),
      '$.suite.executionDependencies.unboundSuitePathReferences',
    ),
  });
}

function readDigest(input: unknown, path: string): string {
  if (typeof input !== 'string' || !SHA256_PATTERN.test(input)) {
    throw new EvidenceValidationError(`${path} must be a lowercase SHA-256 digest.`);
  }
  return input;
}

function readCount(input: unknown, path: string): number {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > MAX_DEPENDENCY_REFERENCES
  ) {
    throw new EvidenceValidationError(
      `${path} must be a safe integer from 0 through ${String(MAX_DEPENDENCY_REFERENCES)}.`,
    );
  }
  return input;
}

function readObject(
  input: unknown,
  path: string,
  required: readonly string[],
): ReadonlyMap<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvidenceValidationError(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(input) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvidenceValidationError(`${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new EvidenceValidationError(`${path} must not contain symbol properties.`);
  }

  const properties = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new EvidenceValidationError(`${path} must contain only enumerable data properties.`);
    }
    properties.set(key, descriptor.value);
  }

  const missing = required.filter((key) => !properties.has(key));
  const unknown = [...properties.keys()].filter((key) => !required.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length === 0 ? '' : `missing ${missing.join(', ')}`,
      unknown.length === 0 ? '' : `unknown ${unknown.join(', ')}`,
    ]
      .filter((entry) => entry.length > 0)
      .join('; ');
    throw new EvidenceValidationError(`${path} has invalid fields: ${details}.`);
  }
  return properties;
}

function containsForbiddenCharacter(segment: string): boolean {
  for (const character of segment) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f || '<>:"|?*'.includes(character)) {
      return true;
    }
  }
  return false;
}

function isWindowsDeviceName(segment: string): boolean {
  const basename = segment.split('.')[0]?.trimEnd().toUpperCase() ?? '';
  return /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(basename);
}
