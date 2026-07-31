import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  assertJsonValue,
  canonicalizeJson,
  jsonDeepEqual,
  JsonPointerError,
  parseStrictJson,
  resolveJsonPointer,
  StrictJsonError,
  validateJsonPointer,
  type JsonValue,
} from './json-pointer.js';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_EXPECTED_BYTES = 64 * 1024;
const MAX_FILE_PATH_LENGTH = 512;
const MAX_POINTER_LENGTH = 2048;
const MAX_ORACLE_DEPTH = 32;
const MAX_ORACLE_NODES = 1024;
const MAX_RULES_PER_COMPOSITE = 64;

export interface ExitCodeEqualsOracleSpec {
  readonly kind: 'exitCodeEquals';
  readonly value: number;
}

export interface StdoutJsonPointerEqualsOracleSpec {
  readonly kind: 'stdoutJsonPointerEquals';
  readonly pointer: string;
  readonly equals: JsonValue;
}

export interface FileJsonPointerEqualsOracleSpec {
  readonly kind: 'fileJsonPointerEquals';
  readonly path: string;
  readonly pointer: string;
  readonly equals: JsonValue;
}

export interface AllOracleSpec {
  readonly kind: 'all';
  readonly rules: readonly OracleSpec[];
}

export interface AnyOracleSpec {
  readonly kind: 'any';
  readonly rules: readonly OracleSpec[];
}

export interface NotOracleSpec {
  readonly kind: 'not';
  readonly rule: OracleSpec;
}

export type OracleSpec =
  | AllOracleSpec
  | AnyOracleSpec
  | ExitCodeEqualsOracleSpec
  | FileJsonPointerEqualsOracleSpec
  | NotOracleSpec
  | StdoutJsonPointerEqualsOracleSpec;

export type ProcessStatus = 'aborted' | 'exited' | 'output_limit' | 'spawn_error' | 'timed_out';

export interface StdoutCapture {
  readonly content: string;
  readonly truncated: boolean;
}

export interface OracleProcessObservation {
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly stdout: StdoutCapture;
}

export interface OracleObservation {
  readonly process: OracleProcessObservation;
  readonly workspaceRoot: string;
}

export type OracleOutcome = 'fail' | 'invalid' | 'pass';

export interface OracleAssertion {
  readonly id: string;
  readonly kind: OracleSpec['kind'];
  readonly outcome: OracleOutcome;
  readonly expected: string;
  readonly actual: string;
}

export interface OracleEvaluation {
  readonly kind: OracleOutcome;
  readonly assertions: readonly OracleAssertion[];
  readonly semanticSignature: string;
}

export class OracleSpecError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OracleSpecError';
  }
}

interface NodeEvaluation {
  readonly outcome: OracleOutcome;
  readonly assertions: readonly OracleAssertion[];
}

interface EvaluationContext {
  readonly observation: OracleObservation;
  readonly fileCache: Map<string, Promise<FileLoadResult>>;
  readonly stdoutJson: ParsedCapture;
  readonly workspace: Promise<WorkspaceResult>;
}

type ParsedCapture =
  | { readonly kind: 'invalid'; readonly summary: string }
  | { readonly kind: 'malformed'; readonly summary: string }
  | { readonly kind: 'ok'; readonly value: JsonValue };

type WorkspaceResult =
  | { readonly kind: 'invalid'; readonly summary: string }
  | { readonly kind: 'ok'; readonly realRoot: string };

type FileLoadResult =
  | { readonly kind: 'invalid'; readonly summary: string }
  | { readonly kind: 'malformed'; readonly summary: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly value: JsonValue };

interface SpecCloneState {
  readonly active: WeakSet<object>;
  nodes: number;
}

export async function evaluateOracle(
  inputSpec: OracleSpec,
  observation: OracleObservation,
): Promise<OracleEvaluation> {
  const spec = cloneAndValidateOracleSpec(inputSpec);
  const harnessStatus = readHarnessStatus(observation);
  if (harnessStatus !== 'exited') {
    return finishEvaluation(invalidTree(spec, 'oracle', `harness status ${harnessStatus}`), spec);
  }

  try {
    const context: EvaluationContext = {
      observation,
      fileCache: new Map<string, Promise<FileLoadResult>>(),
      stdoutJson: parseStdoutCapture(observation),
      workspace: prepareWorkspace(observation),
    };
    return finishEvaluation(await evaluateNode(spec, 'oracle', context), spec);
  } catch {
    return finishEvaluation(invalidTree(spec, 'oracle', 'oracle evaluation failed safely'), spec);
  }
}

function finishEvaluation(node: NodeEvaluation, spec: OracleSpec): OracleEvaluation {
  const semanticProjection = {
    version: 1,
    spec,
    kind: node.outcome,
    assertions: node.assertions.map(({ id, kind, outcome, expected, actual }) => ({
      id,
      kind,
      outcome,
      expected,
      actual,
    })),
  };
  const signature = createHash('sha256')
    .update(JSON.stringify(semanticProjection), 'utf8')
    .digest('hex');
  return {
    kind: node.outcome,
    assertions: node.assertions,
    semanticSignature: `sha256:${signature}`,
  };
}

async function evaluateNode(
  spec: OracleSpec,
  id: string,
  context: EvaluationContext,
): Promise<NodeEvaluation> {
  switch (spec.kind) {
    case 'exitCodeEquals':
      return evaluateExitCode(spec, id, context.observation);
    case 'stdoutJsonPointerEquals':
      return evaluateStdout(spec, id, context.stdoutJson);
    case 'fileJsonPointerEquals':
      return evaluateFile(spec, id, await loadFile(spec.path, context));
    case 'all':
    case 'any': {
      const children: NodeEvaluation[] = [];
      for (const [index, child] of spec.rules.entries()) {
        children.push(await evaluateNode(child, `${id}.${String(index)}`, context));
      }
      const outcome = combineOutcomes(
        spec.kind,
        children.map((child) => child.outcome),
      );
      return {
        outcome,
        assertions: [
          {
            id,
            kind: spec.kind,
            outcome,
            expected:
              spec.kind === 'all'
                ? 'all child assertions pass'
                : 'at least one child assertion passes',
            actual: summarizeChildOutcomes(children),
          },
          ...children.flatMap((child) => child.assertions),
        ],
      };
    }
    case 'not': {
      const child = await evaluateNode(spec.rule, `${id}.0`, context);
      const outcome =
        child.outcome === 'invalid' ? 'invalid' : child.outcome === 'pass' ? 'fail' : 'pass';
      return {
        outcome,
        assertions: [
          {
            id,
            kind: 'not',
            outcome,
            expected: 'child assertion does not pass',
            actual: `child outcome ${child.outcome}`,
          },
          ...child.assertions,
        ],
      };
    }
  }
}

function evaluateExitCode(
  spec: ExitCodeEqualsOracleSpec,
  id: string,
  observation: OracleObservation,
): NodeEvaluation {
  const actualCode = observation.process.exitCode;
  if (typeof actualCode !== 'number' || !Number.isSafeInteger(actualCode)) {
    return leaf(
      id,
      spec.kind,
      'invalid',
      `exit code ${String(spec.value)}`,
      'exit code unavailable',
    );
  }
  const outcome = actualCode === spec.value ? 'pass' : 'fail';
  return leaf(
    id,
    spec.kind,
    outcome,
    `exit code ${String(spec.value)}`,
    `exit code ${String(actualCode)}`,
  );
}

function evaluateStdout(
  spec: StdoutJsonPointerEqualsOracleSpec,
  id: string,
  capture: ParsedCapture,
): NodeEvaluation {
  const expected = summarizeJsonValue(spec.equals);
  if (capture.kind !== 'ok') {
    return leaf(
      id,
      spec.kind,
      capture.kind === 'invalid' ? 'invalid' : 'fail',
      expected,
      capture.summary,
    );
  }
  return evaluatePointer(id, spec.kind, capture.value, spec.pointer, spec.equals);
}

function evaluateFile(
  spec: FileJsonPointerEqualsOracleSpec,
  id: string,
  file: FileLoadResult,
): NodeEvaluation {
  const expected = summarizeJsonValue(spec.equals);
  switch (file.kind) {
    case 'invalid':
      return leaf(id, spec.kind, 'invalid', expected, file.summary);
    case 'malformed':
      return leaf(id, spec.kind, 'fail', expected, file.summary);
    case 'missing':
      return leaf(id, spec.kind, 'fail', expected, 'file does not exist');
    case 'ok':
      return evaluatePointer(id, spec.kind, file.value, spec.pointer, spec.equals);
  }
}

function evaluatePointer(
  id: string,
  kind: FileJsonPointerEqualsOracleSpec['kind'] | StdoutJsonPointerEqualsOracleSpec['kind'],
  document: JsonValue,
  pointer: string,
  expectedValue: JsonValue,
): NodeEvaluation {
  const expected = summarizeJsonValue(expectedValue);
  const resolved = resolveJsonPointer(document, pointer);
  if (!resolved.found) {
    return leaf(id, kind, 'fail', expected, 'JSON Pointer did not resolve');
  }
  const outcome = jsonDeepEqual(resolved.value, expectedValue) ? 'pass' : 'fail';
  return leaf(id, kind, outcome, expected, summarizeJsonValue(resolved.value));
}

function leaf(
  id: string,
  kind: OracleSpec['kind'],
  outcome: OracleOutcome,
  expected: string,
  actual: string,
): NodeEvaluation {
  return {
    outcome,
    assertions: [{ id, kind, outcome, expected, actual }],
  };
}

function invalidTree(spec: OracleSpec, id: string, actual: string): NodeEvaluation {
  const assertion: OracleAssertion = {
    id,
    kind: spec.kind,
    outcome: 'invalid',
    expected: expectedSummary(spec),
    actual,
  };

  switch (spec.kind) {
    case 'all':
    case 'any':
      return {
        outcome: 'invalid',
        assertions: [
          assertion,
          ...spec.rules.flatMap(
            (child, index) => invalidTree(child, `${id}.${String(index)}`, actual).assertions,
          ),
        ],
      };
    case 'not':
      return {
        outcome: 'invalid',
        assertions: [assertion, ...invalidTree(spec.rule, `${id}.0`, actual).assertions],
      };
    default:
      return { outcome: 'invalid', assertions: [assertion] };
  }
}

function expectedSummary(spec: OracleSpec): string {
  switch (spec.kind) {
    case 'exitCodeEquals':
      return `exit code ${String(spec.value)}`;
    case 'stdoutJsonPointerEquals':
    case 'fileJsonPointerEquals':
      return summarizeJsonValue(spec.equals);
    case 'all':
      return 'all child assertions pass';
    case 'any':
      return 'at least one child assertion passes';
    case 'not':
      return 'child assertion does not pass';
  }
}

function combineOutcomes(kind: 'all' | 'any', outcomes: readonly OracleOutcome[]): OracleOutcome {
  if (kind === 'all') {
    if (outcomes.includes('fail')) {
      return 'fail';
    }
    return outcomes.includes('invalid') ? 'invalid' : 'pass';
  }
  if (outcomes.includes('pass')) {
    return 'pass';
  }
  return outcomes.includes('invalid') ? 'invalid' : 'fail';
}

function summarizeChildOutcomes(children: readonly NodeEvaluation[]): string {
  const counts: Record<OracleOutcome, number> = {
    pass: 0,
    fail: 0,
    invalid: 0,
  };
  for (const child of children) {
    counts[child.outcome] += 1;
  }
  return `children(pass=${String(counts.pass)},fail=${String(counts.fail)},invalid=${String(counts.invalid)})`;
}

function summarizeJsonValue(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return `boolean:${String(value)}`;
  }
  if (typeof value === 'number') {
    return `number:${Object.is(value, -0) ? '0' : String(value)}`;
  }

  const digest = createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
  if (typeof value === 'string') {
    return `string(length=${String(value.length)},sha256=${digest})`;
  }
  if (Array.isArray(value)) {
    return `array(length=${String(value.length)},sha256=${digest})`;
  }
  return `object(keys=${String(Object.keys(value).length)},sha256=${digest})`;
}

function parseStdoutCapture(observation: OracleObservation): ParsedCapture {
  const capture: unknown = observation.process.stdout;
  if (
    capture === null ||
    typeof capture !== 'object' ||
    !('content' in capture) ||
    typeof capture.content !== 'string' ||
    !('truncated' in capture) ||
    typeof capture.truncated !== 'boolean'
  ) {
    return { kind: 'invalid', summary: 'stdout capture is unavailable' };
  }
  if (capture.truncated) {
    return { kind: 'invalid', summary: 'stdout capture was truncated' };
  }
  if (Buffer.byteLength(capture.content, 'utf8') > MAX_CAPTURE_BYTES) {
    return {
      kind: 'invalid',
      summary: 'stdout exceeds the JSON inspection limit',
    };
  }

  try {
    return { kind: 'ok', value: parseStrictJson(capture.content) };
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return { kind: 'malformed', summary: 'stdout is not strict JSON' };
    }
    return { kind: 'invalid', summary: 'stdout could not be inspected' };
  }
}

async function prepareWorkspace(observation: OracleObservation): Promise<WorkspaceResult> {
  if (typeof observation.workspaceRoot !== 'string' || !isAbsolute(observation.workspaceRoot)) {
    return {
      kind: 'invalid',
      summary: 'workspace root is not an absolute directory',
    };
  }

  try {
    const realRoot = await realpath(observation.workspaceRoot);
    const rootStats = await lstat(realRoot);
    if (!rootStats.isDirectory()) {
      return {
        kind: 'invalid',
        summary: 'workspace root is not a directory',
      };
    }
    return { kind: 'ok', realRoot };
  } catch {
    return { kind: 'invalid', summary: 'workspace root is unavailable' };
  }
}

function loadFile(relativePath: string, context: EvaluationContext): Promise<FileLoadResult> {
  const cached = context.fileCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }

  const pending = loadFileUncached(relativePath, context.workspace);
  context.fileCache.set(relativePath, pending);
  return pending;
}

async function loadFileUncached(
  relativePath: string,
  workspacePromise: Promise<WorkspaceResult>,
): Promise<FileLoadResult> {
  const workspace = await workspacePromise;
  if (workspace.kind === 'invalid') {
    return workspace;
  }

  const segments = relativePath.split('/');
  let candidate = workspace.realRoot;
  try {
    for (const [index, segment] of segments.entries()) {
      candidate = join(candidate, segment);
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        return {
          kind: 'invalid',
          summary: 'file path contains a symbolic link',
        };
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        return { kind: 'missing' };
      }
      if (index === segments.length - 1 && !stats.isFile()) {
        return {
          kind: 'invalid',
          summary: 'file path does not name a regular file',
        };
      }
    }
  } catch (error) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'invalid', summary: 'file metadata is unavailable' };
  }

  try {
    const resolvedFile = await realpath(candidate);
    if (!isContainedPath(workspace.realRoot, resolvedFile)) {
      return {
        kind: 'invalid',
        summary: 'file path escapes the workspace',
      };
    }
  } catch (error) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'invalid', summary: 'file identity is unavailable' };
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return {
        kind: 'invalid',
        summary: 'file path does not name a regular file',
      };
    }
    if (before.size > BigInt(MAX_CAPTURE_BYTES)) {
      return {
        kind: 'invalid',
        summary: 'file exceeds the JSON inspection limit',
      };
    }

    const bytes = await readBounded(handle);
    if (bytes.length > MAX_CAPTURE_BYTES) {
      return {
        kind: 'invalid',
        summary: 'file exceeds the JSON inspection limit',
      };
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after)) {
      return {
        kind: 'invalid',
        summary: 'file changed while it was inspected',
      };
    }

    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return {
        kind: 'malformed',
        summary: 'file is not valid UTF-8 JSON',
      };
    }

    try {
      return { kind: 'ok', value: parseStrictJson(source) };
    } catch (error) {
      return error instanceof StrictJsonError
        ? { kind: 'malformed', summary: 'file is not strict JSON' }
        : { kind: 'invalid', summary: 'file could not be inspected' };
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: 'missing' };
    }
    if (isSymbolicLinkOpenError(error)) {
      return {
        kind: 'invalid',
        summary: 'file path contains a symbolic link',
      };
    }
    return { kind: 'invalid', summary: 'file could not be opened safely' };
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_CAPTURE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'ELOOP' || error.code === 'EMLINK')
  );
}

function readHarnessStatus(observation: OracleObservation): string {
  try {
    const status = observation.process.status as string;
    return status === 'exited' ||
      status === 'timed_out' ||
      status === 'output_limit' ||
      status === 'aborted' ||
      status === 'spawn_error'
      ? status
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

function cloneAndValidateOracleSpec(input: OracleSpec): OracleSpec {
  try {
    return cloneSpec(input, 'oracle', 0, {
      active: new WeakSet<object>(),
      nodes: 0,
    });
  } catch (error) {
    if (error instanceof OracleSpecError) {
      throw error;
    }
    throw new OracleSpecError('OracleSpec could not be inspected safely.', {
      cause: error,
    });
  }
}

function cloneSpec(input: unknown, path: string, depth: number, state: SpecCloneState): OracleSpec {
  if (depth > MAX_ORACLE_DEPTH) {
    throw new OracleSpecError(
      `OracleSpec exceeds the nesting limit of ${String(MAX_ORACLE_DEPTH)}.`,
    );
  }
  if (!isPlainObject(input)) {
    throw new OracleSpecError(`${path} must be a plain OracleSpec object.`);
  }
  if (state.active.has(input)) {
    throw new OracleSpecError('OracleSpec must not contain a cycle.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_ORACLE_NODES) {
    throw new OracleSpecError(`OracleSpec exceeds the node limit of ${String(MAX_ORACLE_NODES)}.`);
  }

  state.active.add(input);
  try {
    const properties = readDataProperties(input, path);
    const kind = properties.get('kind');
    switch (kind) {
      case 'exitCodeEquals': {
        requireExactProperties(properties, ['kind', 'value'], path);
        const value = properties.get('value');
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          throw new OracleSpecError(`${path}.value must be a safe integer exit code.`);
        }
        return { kind, value };
      }
      case 'stdoutJsonPointerEquals': {
        requireExactProperties(properties, ['equals', 'kind', 'pointer'], path);
        const pointer = validatePointer(properties.get('pointer'), path);
        const equals = cloneExpected(properties.get('equals'), path);
        return { kind, pointer, equals };
      }
      case 'fileJsonPointerEquals': {
        requireExactProperties(properties, ['equals', 'kind', 'path', 'pointer'], path);
        const filePath = validateRelativeFilePath(properties.get('path'), path);
        const pointer = validatePointer(properties.get('pointer'), path);
        const equals = cloneExpected(properties.get('equals'), path);
        return { kind, path: filePath, pointer, equals };
      }
      case 'all':
      case 'any': {
        requireExactProperties(properties, ['kind', 'rules'], path);
        const rules = cloneRules(properties.get('rules'), path, depth, state);
        return { kind, rules };
      }
      case 'not': {
        requireExactProperties(properties, ['kind', 'rule'], path);
        return {
          kind,
          rule: cloneSpec(properties.get('rule'), `${path}.rule`, depth + 1, state),
        };
      }
      default:
        throw new OracleSpecError(`${path}.kind must name a supported OracleSpec variant.`);
    }
  } finally {
    state.active.delete(input);
  }
}

function cloneRules(
  input: unknown,
  path: string,
  depth: number,
  state: SpecCloneState,
): readonly OracleSpec[] {
  if (!Array.isArray(input)) {
    throw new OracleSpecError(`${path}.rules must be an array.`);
  }
  if (state.active.has(input)) {
    throw new OracleSpecError('OracleSpec must not contain a cycle.');
  }
  if (input.length === 0 || input.length > MAX_RULES_PER_COMPOSITE) {
    throw new OracleSpecError(
      `${path}.rules must contain between 1 and ${String(MAX_RULES_PER_COMPOSITE)} entries.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const extraKeys = Object.keys(descriptors).filter(
    (key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key),
  );
  if (extraKeys.length > 0 || Object.getOwnPropertySymbols(input).length > 0) {
    throw new OracleSpecError(`${path}.rules must not contain extra array properties.`);
  }

  state.active.add(input);
  try {
    return Array.from({ length: input.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new OracleSpecError(`${path}.rules must not contain holes or accessors.`);
      }
      return cloneSpec(descriptor.value, `${path}.rules[${String(index)}]`, depth + 1, state);
    });
  } finally {
    state.active.delete(input);
  }
}

function cloneExpected(input: unknown, path: string): JsonValue {
  try {
    assertJsonValue(input, `${path}.equals`);
    const canonical = canonicalizeJson(input);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_EXPECTED_BYTES) {
      throw new TypeError(`expected JSON exceeds ${String(MAX_EXPECTED_BYTES)} bytes`);
    }
    return parseStrictJson(canonical);
  } catch (error) {
    throw new OracleSpecError(
      `${path}.equals must be JSON-serializable within the configured limit.`,
      { cause: error },
    );
  }
}

function validatePointer(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > MAX_POINTER_LENGTH) {
    throw new OracleSpecError(
      `${path}.pointer must be a JSON Pointer no longer than ${String(MAX_POINTER_LENGTH)} characters.`,
    );
  }
  try {
    validateJsonPointer(input);
  } catch (error) {
    if (error instanceof JsonPointerError) {
      throw new OracleSpecError(`${path}.pointer must be a valid JSON Pointer.`, {
        cause: error,
      });
    }
    throw error;
  }
  return input;
}

function validateRelativeFilePath(input: unknown, path: string): string {
  const segments = typeof input === 'string' ? input.split('/') : [];
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_FILE_PATH_LENGTH ||
    input.includes('\\') ||
    input.includes('\0') ||
    /^[A-Za-z]:/u.test(input) ||
    input.startsWith('/') ||
    input.endsWith('/') ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        containsWindowsForbiddenCharacter(segment) ||
        /[ .]$/u.test(segment) ||
        isWindowsDeviceName(segment),
    )
  ) {
    throw new OracleSpecError(`${path}.path must be a normalized relative POSIX path.`);
  }
  return input;
}

function containsWindowsForbiddenCharacter(segment: string): boolean {
  for (const character of segment) {
    if (character.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(character)) {
      return true;
    }
  }
  return false;
}

function isWindowsDeviceName(segment: string): boolean {
  const basename = segment.split('.')[0]?.toUpperCase() ?? '';
  return /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(basename);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function readDataProperties(
  input: Record<string, unknown>,
  path: string,
): ReadonlyMap<string, unknown> {
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new OracleSpecError(`${path} must not contain symbol properties.`);
  }
  const properties = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new OracleSpecError(`${path} must contain only enumerable data properties.`);
    }
    properties.set(key, descriptor.value);
  }
  return properties;
}

function requireExactProperties(
  properties: ReadonlyMap<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = [...properties.keys()].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OracleSpecError(
      `${path} must contain exactly the properties: ${expected.join(', ')}.`,
    );
  }
}
