import { createHash } from 'node:crypto';

import type { ArmClassification, FindingVerdict } from '../experiment/verdict.js';

export const GHOSTCASE_REPORT_SCHEMA = 'ghostcase/report/v1' as const;

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|~[\\/]|\/(?:[^/\s]+\/)*[^/\s]*)/iu;
const CREDENTIAL_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Z][A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN)\b\s*[:=]|\b(?:api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret)\b\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bAKIA[0-9A-Z]{16}\b|\b(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,})/iu;

const MAX_EXPERIMENTS = 4096;
const MAX_REASON_BYTES = 1024;
const MAX_STATE_CHANGES = 10_000;
const MAX_VICTIMS = 256;
const MAX_CHAIN_LENGTH = 64;

export type ReportStatus = 'clean' | 'findings' | 'harness_error' | 'inconclusive';
export type ReportExitCode = 0 | 1 | 2 | 3;
export type ReportMinimality = 'not_applicable' | 'proven' | 'unproven';
export type ReportVerdict = FindingVerdict;
export type ReportStateChangeKind = 'added' | 'modified' | 'removed' | 'type_changed';

export interface StableReportArmSummary {
  readonly kind: 'stable';
  readonly oracleOutcome: 'fail' | 'pass';
  readonly signatureSha256: string;
}

export type IncompleteReportArmSummary =
  | { readonly kind: 'harness_error' }
  | { readonly kind: 'inconclusive' }
  | { readonly kind: 'non_reproducible' };

export type ReportArmSummary = IncompleteReportArmSummary | StableReportArmSummary;

export interface ReportStateChangeInput {
  readonly alias: string;
  readonly digest?: string;
  readonly kind: ReportStateChangeKind;
  readonly size?: number;
  readonly subjectId: string;
}

export interface ReportStateChange {
  readonly alias: string;
  readonly digest?: string;
  readonly kind: ReportStateChangeKind;
  readonly size?: number;
  readonly subjectId: string;
}

export interface GhostCaseVictimReportInput {
  readonly fresh: ReportArmSummary;
  readonly id: string;
  readonly minimalChain: readonly string[];
  readonly minimality: ReportMinimality;
  readonly reason?: string;
  readonly shared: ReportArmSummary;
  readonly stateChanges: readonly ReportStateChangeInput[];
  readonly verdict: ReportVerdict;
}

export interface GhostCaseVictimReport {
  readonly fresh: ReportArmSummary;
  readonly id: string;
  readonly minimalChain: readonly string[];
  readonly minimality: ReportMinimality;
  readonly reason?: string;
  readonly shared: ReportArmSummary;
  readonly stateChanges: readonly ReportStateChange[];
  readonly verdict: ReportVerdict;
}

export interface GhostCaseReportInput {
  readonly exitCode: ReportExitCode;
  readonly experiments: {
    readonly limit: number;
    readonly used: number;
  };
  readonly schema: typeof GHOSTCASE_REPORT_SCHEMA;
  readonly status: ReportStatus;
  readonly suite: {
    readonly id: string;
    readonly sourceSha256: string;
  };
  readonly toolVersion: string;
  readonly victims: readonly GhostCaseVictimReportInput[];
}

export interface GhostCaseReport {
  readonly exitCode: ReportExitCode;
  readonly experiments: {
    readonly limit: number;
    readonly used: number;
  };
  readonly schema: typeof GHOSTCASE_REPORT_SCHEMA;
  readonly status: ReportStatus;
  readonly suite: {
    readonly id: string;
    readonly sourceSha256: string;
  };
  readonly toolVersion: string;
  readonly victims: readonly GhostCaseVictimReport[];
}

export class ReportValidationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReportValidationError';
  }
}

/**
 * Creates a detached, validated and deeply frozen report suitable for evidence output.
 */
export function createReport(input: GhostCaseReportInput): GhostCaseReport {
  return validateReport(input);
}

/**
 * Validates untrusted report-shaped input without retaining references to the source object.
 */
export function validateReport(input: unknown): GhostCaseReport {
  try {
    const root = readObject(input, '$', [
      'exitCode',
      'experiments',
      'schema',
      'status',
      'suite',
      'toolVersion',
      'victims',
    ]);
    const schema = readLiteral(root.get('schema'), '$.schema', GHOSTCASE_REPORT_SCHEMA);
    const toolVersion = readVersion(root.get('toolVersion'), '$.toolVersion');
    const suite = readSuite(root.get('suite'));
    const experiments = readExperiments(root.get('experiments'));
    const victims = readVictims(root.get('victims'));
    const status = readStatus(root.get('status'), '$.status');
    const exitCode = readExitCode(root.get('exitCode'), '$.exitCode');
    const aggregate = aggregateStatus(victims);

    if (status !== aggregate.status) {
      throw new ReportValidationError(
        `$.status must be '${aggregate.status}' for the included victim verdicts.`,
      );
    }
    if (exitCode !== aggregate.exitCode) {
      throw new ReportValidationError(
        `$.exitCode must be ${String(aggregate.exitCode)} when status is '${aggregate.status}'.`,
      );
    }

    return Object.freeze({
      exitCode,
      experiments,
      schema,
      status,
      suite,
      toolVersion,
      victims,
    });
  } catch (error) {
    if (error instanceof ReportValidationError) {
      throw error;
    }
    throw new ReportValidationError('Report input could not be inspected safely.', {
      cause: error,
    });
  }
}

/**
 * Converts an internal arm classification to a report-safe summary.
 * Raw signatures and diagnostic messages never enter the returned value.
 */
export function summarizeArm(classification: ArmClassification): ReportArmSummary {
  if (classification.kind !== 'stable') {
    return Object.freeze({ kind: classification.kind });
  }
  const signatureSha256 = createHash('sha256')
    .update('ghostcase/report-arm-signature/v1\0', 'utf8')
    .update(classification.signature, 'utf8')
    .digest('hex');
  return Object.freeze({
    kind: 'stable',
    oracleOutcome: classification.oracleOutcome,
    signatureSha256,
  });
}

function readSuite(input: unknown): GhostCaseReport['suite'] {
  const suite = readObject(input, '$.suite', ['id', 'sourceSha256']);
  return Object.freeze({
    id: readId(suite.get('id'), '$.suite.id'),
    sourceSha256: readDigest(suite.get('sourceSha256'), '$.suite.sourceSha256'),
  });
}

function readExperiments(input: unknown): GhostCaseReport['experiments'] {
  const experiments = readObject(input, '$.experiments', ['limit', 'used']);
  const limit = readInteger(experiments.get('limit'), '$.experiments.limit', 1, MAX_EXPERIMENTS);
  const used = readInteger(experiments.get('used'), '$.experiments.used', 0, limit);
  return Object.freeze({ limit, used });
}

function readVictims(input: unknown): readonly GhostCaseVictimReport[] {
  const entries = readArray(input, '$.victims', 1, MAX_VICTIMS);
  const victims = entries.map((entry, index) => readVictim(entry, index));
  const seen = new Set<string>();
  for (const victim of victims) {
    if (seen.has(victim.id)) {
      throw new ReportValidationError(`$.victims contains duplicate id '${victim.id}'.`);
    }
    seen.add(victim.id);
  }
  return Object.freeze(victims);
}

function readVictim(input: unknown, index: number): GhostCaseVictimReport {
  const path = `$.victims[${String(index)}]`;
  const victim = readObject(
    input,
    path,
    ['fresh', 'id', 'minimalChain', 'minimality', 'shared', 'stateChanges', 'verdict'],
    ['reason'],
  );
  const id = readId(victim.get('id'), `${path}.id`);
  const verdict = readVerdict(victim.get('verdict'), `${path}.verdict`);
  const fresh = readArm(victim.get('fresh'), `${path}.fresh`);
  const shared = readArm(victim.get('shared'), `${path}.shared`);
  const minimalChain = readChain(victim.get('minimalChain'), `${path}.minimalChain`, id);
  const minimality = readMinimality(victim.get('minimality'), `${path}.minimality`);
  const stateChanges = readStateChanges(victim.get('stateChanges'), `${path}.stateChanges`);
  const reasonValue = victim.get('reason');
  const reason =
    reasonValue === undefined ? undefined : readSafeReason(reasonValue, `${path}.reason`);

  validateVictimSemantics({
    fresh,
    id,
    minimalChain,
    minimality,
    shared,
    verdict,
  });

  return Object.freeze({
    fresh,
    id,
    minimalChain,
    minimality,
    ...(reason === undefined ? {} : { reason }),
    shared,
    stateChanges,
    verdict,
  });
}

function readArm(input: unknown, path: string): ReportArmSummary {
  const base = readObjectWithDynamicKeys(input, path);
  const kind = base.get('kind');
  if (kind === 'stable') {
    requireKeys(base, path, ['kind', 'oracleOutcome', 'signatureSha256']);
    const oracleOutcome = readUnion(base.get('oracleOutcome'), `${path}.oracleOutcome`, [
      'fail',
      'pass',
    ] as const);
    return Object.freeze({
      kind,
      oracleOutcome,
      signatureSha256: readDigest(base.get('signatureSha256'), `${path}.signatureSha256`),
    });
  }
  requireKeys(base, path, ['kind']);
  return Object.freeze({
    kind: readUnion(kind, `${path}.kind`, [
      'harness_error',
      'inconclusive',
      'non_reproducible',
    ] as const),
  });
}

function readChain(input: unknown, path: string, victimId: string): readonly string[] {
  const entries = readArray(input, path, 0, MAX_CHAIN_LENGTH);
  const chain = entries.map((entry, index) => readId(entry, `${path}[${String(index)}]`));
  const seen = new Set<string>();
  for (const id of chain) {
    if (id === victimId) {
      throw new ReportValidationError(`${path} must not contain the victim id '${victimId}'.`);
    }
    if (seen.has(id)) {
      throw new ReportValidationError(`${path} must not contain duplicate case ids.`);
    }
    seen.add(id);
  }
  return Object.freeze(chain);
}

function readStateChanges(input: unknown, path: string): readonly ReportStateChange[] {
  const entries = readArray(input, path, 0, MAX_STATE_CHANGES);
  const changes = entries.map((entry, index) =>
    readStateChange(entry, `${path}[${String(index)}]`),
  );
  changes.sort(compareStateChanges);
  return Object.freeze(changes);
}

function readStateChange(input: unknown, path: string): ReportStateChange {
  const change = readObject(input, path, ['alias', 'kind', 'subjectId'], ['digest', 'size']);
  const alias = readId(change.get('alias'), `${path}.alias`);
  const subjectId = readDigest(change.get('subjectId'), `${path}.subjectId`);
  const kind = readUnion(change.get('kind'), `${path}.kind`, [
    'added',
    'modified',
    'removed',
    'type_changed',
  ] as const);
  const digestValue = change.get('digest');
  const sizeValue = change.get('size');
  const digest = digestValue === undefined ? undefined : readDigest(digestValue, `${path}.digest`);
  const size =
    sizeValue === undefined
      ? undefined
      : readInteger(sizeValue, `${path}.size`, 0, Number.MAX_SAFE_INTEGER);

  return Object.freeze({
    alias,
    ...(digest === undefined ? {} : { digest }),
    kind,
    ...(size === undefined ? {} : { size }),
    subjectId,
  });
}

function validateVictimSemantics(input: {
  readonly fresh: ReportArmSummary;
  readonly id: string;
  readonly minimalChain: readonly string[];
  readonly minimality: ReportMinimality;
  readonly shared: ReportArmSummary;
  readonly verdict: ReportVerdict;
}): void {
  const classified = classifyReportArms(input.fresh, input.shared);
  if (classified !== input.verdict) {
    throw new ReportValidationError(
      `Victim '${input.id}' verdict '${input.verdict}' does not match its fresh/shared summaries.`,
    );
  }

  const finding = isFinding(input.verdict);
  if (finding && input.minimalChain.length === 0) {
    throw new ReportValidationError(`Victim '${input.id}' finding must include a minimalChain.`);
  }
  if (finding && input.minimality === 'not_applicable') {
    throw new ReportValidationError(`Victim '${input.id}' finding must declare minimality.`);
  }
  if (input.verdict === 'CLEAN' && input.minimalChain.length > 0) {
    throw new ReportValidationError(`Victim '${input.id}' CLEAN verdict cannot include a chain.`);
  }
  if (input.verdict === 'CLEAN' && input.minimality !== 'not_applicable') {
    throw new ReportValidationError(
      `Victim '${input.id}' CLEAN verdict must use not_applicable minimality.`,
    );
  }
  if (!finding && input.minimalChain.length === 0 && input.minimality !== 'not_applicable') {
    throw new ReportValidationError(
      `Victim '${input.id}' without a candidate chain must use not_applicable minimality.`,
    );
  }
  if (!finding && input.minimalChain.length > 0 && input.minimality !== 'unproven') {
    throw new ReportValidationError(
      `Victim '${input.id}' incomplete candidate chain must use unproven minimality.`,
    );
  }
}

function classifyReportArms(fresh: ReportArmSummary, shared: ReportArmSummary): ReportVerdict {
  if (fresh.kind === 'harness_error' || shared.kind === 'harness_error') {
    return 'HARNESS_ERROR';
  }
  if (fresh.kind === 'non_reproducible' || shared.kind === 'non_reproducible') {
    return 'NON_REPRODUCIBLE';
  }
  if (fresh.kind === 'inconclusive' || shared.kind === 'inconclusive') {
    return 'INCONCLUSIVE';
  }
  if (fresh.oracleOutcome === 'pass' && shared.oracleOutcome === 'fail') {
    return 'POLLUTION';
  }
  if (fresh.oracleOutcome === 'fail' && shared.oracleOutcome === 'pass') {
    return 'HIDDEN_DEPENDENCY';
  }
  return fresh.signatureSha256 === shared.signatureSha256 ? 'CLEAN' : 'OUTCOME_SHIFT';
}

function aggregateStatus(victims: readonly GhostCaseVictimReport[]): {
  readonly exitCode: ReportExitCode;
  readonly status: ReportStatus;
} {
  let severity: 0 | 1 | 2 | 3 = 0;
  for (const victim of victims) {
    const victimSeverity: 0 | 1 | 2 | 3 =
      victim.verdict === 'HARNESS_ERROR'
        ? 3
        : victim.verdict === 'INCONCLUSIVE' || victim.verdict === 'NON_REPRODUCIBLE'
          ? 2
          : isFinding(victim.verdict)
            ? 1
            : 0;
    if (victimSeverity > severity) {
      severity = victimSeverity;
    }
  }
  const statuses = ['clean', 'findings', 'inconclusive', 'harness_error'] as const;
  const exitCode = severity === 0 ? 0 : severity === 1 ? 1 : 3;
  return Object.freeze({
    exitCode,
    status: statuses[severity],
  });
}

function isFinding(verdict: ReportVerdict): boolean {
  return verdict === 'HIDDEN_DEPENDENCY' || verdict === 'OUTCOME_SHIFT' || verdict === 'POLLUTION';
}

function readObject(
  input: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, unknown> {
  const properties = readObjectWithDynamicKeys(input, path);
  requireKeys(properties, path, required, optional);
  return properties;
}

function readObjectWithDynamicKeys(input: unknown, path: string): ReadonlyMap<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReportValidationError(`${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(input) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReportValidationError(`${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new ReportValidationError(`${path} must not contain symbol properties.`);
  }
  const properties = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new ReportValidationError(`${path} must contain only enumerable data properties.`);
    }
    properties.set(key, descriptor.value);
  }
  return properties;
}

function requireKeys(
  properties: ReadonlyMap<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !properties.has(key));
  const unknown = [...properties.keys()].filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length === 0 ? '' : `missing ${missing.join(', ')}`,
      unknown.length === 0 ? '' : `unknown ${unknown.join(', ')}`,
    ]
      .filter((entry) => entry.length > 0)
      .join('; ');
    throw new ReportValidationError(`${path} has invalid fields: ${details}.`);
  }
}

function readArray(
  input: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new ReportValidationError(`${path} must be an array.`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new ReportValidationError(`${path} must not contain symbol properties.`);
  }
  if (input.length < minimum || input.length > maximum) {
    throw new ReportValidationError(
      `${path} must contain between ${String(minimum)} and ${String(maximum)} entries.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors).filter((key) => key !== 'length');
  const expectedKeys = Array.from({ length: input.length }, (_, index) => String(index));
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ReportValidationError(`${path} must be dense and contain no extra properties.`);
  }
  return expectedKeys.map((key) => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new ReportValidationError(`${path} must contain only enumerable data entries.`);
    }
    const value: unknown = descriptor.value;
    return value;
  });
}

function readId(input: unknown, path: string): string {
  if (typeof input !== 'string' || !ID_PATTERN.test(input)) {
    throw new ReportValidationError(`${path} must match ^[a-z][a-z0-9_-]{0,63}$.`);
  }
  return input;
}

function readDigest(input: unknown, path: string): string {
  if (typeof input !== 'string' || !SHA256_PATTERN.test(input)) {
    throw new ReportValidationError(`${path} must be a lowercase SHA-256 digest.`);
  }
  return input;
}

function readVersion(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > 128 || !SEMVER_PATTERN.test(input)) {
    throw new ReportValidationError(`${path} must be a valid semantic version.`);
  }
  return input;
}

function readSafeReason(input: unknown, path: string): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    Buffer.byteLength(input, 'utf8') > MAX_REASON_BYTES ||
    containsControlCharacter(input) ||
    containsLoneSurrogate(input) ||
    ABSOLUTE_PATH_PATTERN.test(input) ||
    CREDENTIAL_PATTERN.test(input)
  ) {
    throw new ReportValidationError(
      `${path} must be a bounded single-line safe diagnostic without paths or credentials.`,
    );
  }
  return input;
}

function readInteger(input: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw new ReportValidationError(
      `${path} must be a safe integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  return input;
}

function readLiteral<const T extends string>(input: unknown, path: string, expected: T): T {
  if (input !== expected) {
    throw new ReportValidationError(`${path} must be '${expected}'.`);
  }
  return expected;
}

function readUnion<const T extends readonly string[]>(
  input: unknown,
  path: string,
  allowed: T,
): T[number] {
  if (typeof input !== 'string' || !allowed.includes(input)) {
    throw new ReportValidationError(`${path} must be one of: ${allowed.join(', ')}.`);
  }
  return input;
}

function readStatus(input: unknown, path: string): ReportStatus {
  return readUnion(input, path, ['clean', 'findings', 'inconclusive', 'harness_error'] as const);
}

function readExitCode(input: unknown, path: string): ReportExitCode {
  if (input !== 0 && input !== 1 && input !== 2 && input !== 3) {
    throw new ReportValidationError(`${path} must be 0, 1, 2, or 3.`);
  }
  return input;
}

function readVerdict(input: unknown, path: string): ReportVerdict {
  return readUnion(input, path, [
    'CLEAN',
    'HARNESS_ERROR',
    'HIDDEN_DEPENDENCY',
    'INCONCLUSIVE',
    'NON_REPRODUCIBLE',
    'OUTCOME_SHIFT',
    'POLLUTION',
  ] as const);
}

function readMinimality(input: unknown, path: string): ReportMinimality {
  return readUnion(input, path, ['not_applicable', 'proven', 'unproven'] as const);
}

function compareStateChanges(left: ReportStateChange, right: ReportStateChange): number {
  const aliasOrder = compareUtf8(left.alias, right.alias);
  if (aliasOrder !== 0) {
    return aliasOrder;
  }
  const subjectOrder = compareUtf8(left.subjectId, right.subjectId);
  return subjectOrder === 0 ? compareUtf8(left.kind, right.kind) : subjectOrder;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}
