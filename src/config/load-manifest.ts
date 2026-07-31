import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

import { ConfigError, errorMessage } from '../domain/errors.js';
import type {
  AdapterSpec,
  CaseSpec,
  CommandSpec,
  EnvironmentPatch,
  EnvironmentSpec,
  ExecutionSpec,
  LoadedManifest,
  ManifestDefinition,
  PathReference,
  PlatformName,
  ProgramSpec,
  ResolvedStateRoot,
  RunPatch,
  SnapshotSpec,
  StateRootSpec,
  StdinSpec,
  SuiteSearch,
  SuiteSpec,
  ValueSpec,
  WorkingDirectorySpec,
} from '../domain/model.js';
import {
  assertJsonValue,
  canonicalizeJson,
  JsonPointerError,
  parseStrictJson,
  validateJsonPointer,
  type JsonValue,
  type OracleSpec,
} from '../oracle/index.js';
import { parsePortablePath, resolvePortablePath } from './portable-path.js';
import { parseStrictJsonBytes, StrictJsonError } from './strict-json.js';

export const MANIFEST_FILE_MAX_BYTES = 256 * 1024;

export const MANIFEST_HARD_LIMITS = Object.freeze({
  maxArgBytes: 16 * 1024,
  maxArgs: 128,
  maxArgvBytes: 64 * 1024,
  maxArmTimeoutMs: 30 * 60 * 1000,
  maxCaseSetupCommands: 8,
  maxCaseTimeoutMs: 10 * 60 * 1000,
  maxCases: 256,
  maxCleanupTimeoutMs: 2 * 60 * 1000,
  maxCommandTimeoutMs: 10 * 60 * 1000,
  maxDescriptionBytes: 1024,
  maxEnvEntries: 64,
  maxEnvNameCharacters: 128,
  maxEnvValueBytes: 16 * 1024,
  maxEnvironmentBytes: 64 * 1024,
  maxExperiments: 4096,
  maxInheritedEnv: 32,
  maxOracleDepth: 32,
  maxOracleNodes: 1024,
  maxOracleRules: 64,
  maxSearchChainLength: 64,
  maxSetupCommands: 16,
  maxSnapshotBytes: 256 * 1024 * 1024,
  maxSnapshotEntries: 10_000,
  maxSnapshotFileBytes: 64 * 1024 * 1024,
  maxStateRoots: 16,
  maxStderrBytes: 32 * 1024 * 1024,
  maxStdinBytes: 16 * 1024 * 1024,
  maxStdoutBytes: 32 * 1024 * 1024,
  maxSuiteTimeoutMs: 24 * 60 * 60 * 1000,
  maxTags: 16,
  maxTextBytes: 1024 * 1024,
  maxValueBytes: 16 * 1024,
  minCases: 2,
  minRepetitions: 2,
  minTimeoutMs: 100,
  maxRepetitions: 9,
});

export const DEFAULT_SEARCH: SuiteSearch = Object.freeze({
  maxChainLength: 8,
  maxExperiments: 256,
});

const EMPTY_VALUES: Readonly<Record<string, ValueSpec>> = Object.freeze({});
const EMPTY_ENV_PATCH: EnvironmentPatch = Object.freeze({
  set: EMPTY_VALUES,
  unset: Object.freeze([]),
});

export const DEFAULT_ENVIRONMENT: EnvironmentSpec = Object.freeze({
  inherit: Object.freeze([]),
  set: EMPTY_VALUES,
  unset: Object.freeze([]),
});

export const DEFAULT_EXECUTION: ExecutionSpec = Object.freeze({
  armTimeoutMs: 300_000,
  caseTimeoutMs: 60_000,
  cleanupTimeoutMs: 30_000,
  maxSnapshotBytes: 256 * 1024 * 1024,
  maxSnapshotEntries: 10_000,
  maxSnapshotFileBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  maxStdinBytes: 1024 * 1024,
  maxStdoutBytes: 1024 * 1024,
  stepTimeoutMs: 30_000,
  suiteTimeoutMs: 1_800_000,
});

const topLevelFields = new Set([
  'adapter',
  'cases',
  'environment',
  'execution',
  'schema',
  'stateRoots',
  'suite',
]);
const suiteFields = new Set(['description', 'id', 'repetitions', 'search']);
const searchFields = new Set(['maxChainLength', 'maxExperiments']);
const stateRootFields = new Set(['id', 'seed']);
const adapterFields = new Set(['oracle', 'reset', 'run', 'setup', 'snapshot']);
const commandFields = new Set(['argv', 'cwd', 'env', 'program', 'stdin', 'timeoutMs']);
const runPatchFields = new Set(['argv', 'cwd', 'env', 'stdin', 'timeoutMs']);
const environmentFields = new Set(['inherit', 'set', 'unset']);
const environmentPatchFields = new Set(['set', 'unset']);
const executionFields = new Set([
  'armTimeoutMs',
  'caseTimeoutMs',
  'cleanupTimeoutMs',
  'maxSnapshotBytes',
  'maxSnapshotEntries',
  'maxSnapshotFileBytes',
  'maxStderrBytes',
  'maxStdinBytes',
  'maxStdoutBytes',
  'stepTimeoutMs',
  'suiteTimeoutMs',
]);
const caseFields = new Set(['description', 'id', 'oracle', 'platforms', 'run', 'setup', 'tags']);
const snapshotFields = new Set(['roots']);
const snapshotRootFields = new Set(['root']);
const pathReferenceFields = new Set(['base', 'path', 'root']);
const programLookupFields = new Set(['lookup']);
const programPathFields = new Set(['path']);
const stdinNoneFields = new Set(['kind']);
const stdinTextFields = new Set(['kind', 'value']);
const stdinFileFields = new Set(['kind', 'path']);
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const executableLookupPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const platformNames = new Set<PlatformName>(['linux', 'win32']);
const forbiddenEnvironmentNames = new Set([
  'BASH_ENV',
  'COMSPEC',
  'ENV',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',
  'PATHEXT',
]);
const forbiddenJsonKeys = new Set(['__proto__', 'constructor', 'prototype']);

type UnknownObject = Record<string, unknown>;

interface OracleParseState {
  readonly active: WeakSet<object>;
  nodes: number;
}

export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  if (manifestPath.length === 0) {
    throw new ConfigError('Manifest file path must not be empty.');
  }
  if (manifestPath.includes('\0')) {
    throw new ConfigError('Manifest file path contains a NUL byte.');
  }

  const sourcePath = resolve(manifestPath);
  const bytes = await readManifestFile(sourcePath);
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new ConfigError(
        `Manifest file '${sourcePath}' failed strict JSON validation: ${error.message}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  const definition = parseManifest(parsed);
  const suiteDir = dirname(sourcePath);
  const stateRoots: ResolvedStateRoot[] = definition.stateRoots.map((root) =>
    root.seed.kind === 'empty'
      ? {
          id: root.id,
          seed: { kind: 'empty' },
        }
      : {
          id: root.id,
          seed: {
            kind: 'copy',
            path: root.seed.path,
            resolvedPath: resolvePortablePath(suiteDir, root.seed.path),
          },
        },
  );

  return deepFreeze({
    definition,
    sourcePath,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    stateRoots,
    suiteDir,
  });
}

export function parseManifest(value: unknown): ManifestDefinition {
  const input = requireObject(value, '$');
  assertKnownFields(input, topLevelFields, '$');

  const schema = requireStringField(input, 'schema', '$');
  if (schema !== 'ghostcase/suite/v1') {
    throw new ConfigError("$.schema must equal 'ghostcase/suite/v1'.");
  }

  const suite = parseSuite(requireField(input, 'suite', '$'));
  const stateRoots = parseStateRoots(requireField(input, 'stateRoots', '$'));
  const rootIds = new Set(stateRoots.map(({ id }) => id));
  const execution = parseExecution(optionalValue(input, 'execution'));
  const environment = parseEnvironment(optionalValue(input, 'environment'), rootIds);
  const adapter = parseAdapter(
    requireField(input, 'adapter', '$'),
    rootIds,
    stateRoots[0]?.id ?? '',
    execution,
  );
  const cases = parseCases(
    requireField(input, 'cases', '$'),
    rootIds,
    stateRoots[0]?.id ?? '',
    execution,
    adapter.run.argv,
  );

  return deepFreeze({
    adapter,
    cases,
    environment,
    execution,
    schema,
    stateRoots,
    suite,
  });
}

function parseSuite(value: unknown): SuiteSpec {
  const input = requireObject(value, '$.suite');
  assertKnownFields(input, suiteFields, '$.suite');
  return {
    description: optionalDescription(input, 'description', '$.suite'),
    id: parseId(requireField(input, 'id', '$.suite'), '$.suite.id'),
    repetitions: optionalBoundedIntegerField(
      input,
      'repetitions',
      '$.suite',
      MANIFEST_HARD_LIMITS.minRepetitions,
      MANIFEST_HARD_LIMITS.maxRepetitions,
      3,
    ),
    search: parseSearch(optionalValue(input, 'search')),
  };
}

function parseSearch(value: unknown): SuiteSearch {
  if (value === undefined) {
    return DEFAULT_SEARCH;
  }
  const input = requireObject(value, '$.suite.search');
  assertKnownFields(input, searchFields, '$.suite.search');
  return {
    maxChainLength: optionalBoundedIntegerField(
      input,
      'maxChainLength',
      '$.suite.search',
      1,
      MANIFEST_HARD_LIMITS.maxSearchChainLength,
      DEFAULT_SEARCH.maxChainLength,
    ),
    maxExperiments: optionalBoundedIntegerField(
      input,
      'maxExperiments',
      '$.suite.search',
      1,
      MANIFEST_HARD_LIMITS.maxExperiments,
      DEFAULT_SEARCH.maxExperiments,
    ),
  };
}

function parseStateRoots(value: unknown): readonly StateRootSpec[] {
  const entries = requireArray(value, '$.stateRoots');
  requireArrayLength(entries, '$.stateRoots', 1, MANIFEST_HARD_LIMITS.maxStateRoots);
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    const jsonPath = `$.stateRoots[${String(index)}]`;
    const input = requireObject(entry, jsonPath);
    assertKnownFields(input, stateRootFields, jsonPath);
    const id = parseId(requireField(input, 'id', jsonPath), `${jsonPath}.id`);
    if (ids.has(id)) {
      throw new ConfigError('Manifest state-root IDs must be unique.');
    }
    ids.add(id);
    return {
      id,
      seed: parseSeed(requireField(input, 'seed', jsonPath), `${jsonPath}.seed`),
    };
  });
}

function parseSeed(value: unknown, jsonPath: string): StateRootSpec['seed'] {
  const input = requireObject(value, jsonPath);
  const kind = requireStringField(input, 'kind', jsonPath);
  if (kind === 'empty') {
    assertKnownFields(input, new Set(['kind']), jsonPath);
    return { kind };
  }
  if (kind === 'copy') {
    assertKnownFields(input, new Set(['kind', 'path']), jsonPath);
    return {
      kind,
      path: parsePortablePath(requireField(input, 'path', jsonPath), `${jsonPath}.path`),
    };
  }
  throw new ConfigError(`${jsonPath}.kind must equal 'empty' or 'copy'.`);
}

function parseExecution(value: unknown): ExecutionSpec {
  if (value === undefined) {
    return DEFAULT_EXECUTION;
  }
  const input = requireObject(value, '$.execution');
  assertKnownFields(input, executionFields, '$.execution');
  const execution: ExecutionSpec = {
    armTimeoutMs: optionalBoundedIntegerField(
      input,
      'armTimeoutMs',
      '$.execution',
      1_000,
      MANIFEST_HARD_LIMITS.maxArmTimeoutMs,
      DEFAULT_EXECUTION.armTimeoutMs,
    ),
    caseTimeoutMs: optionalBoundedIntegerField(
      input,
      'caseTimeoutMs',
      '$.execution',
      1_000,
      MANIFEST_HARD_LIMITS.maxCaseTimeoutMs,
      DEFAULT_EXECUTION.caseTimeoutMs,
    ),
    cleanupTimeoutMs: optionalBoundedIntegerField(
      input,
      'cleanupTimeoutMs',
      '$.execution',
      1_000,
      MANIFEST_HARD_LIMITS.maxCleanupTimeoutMs,
      DEFAULT_EXECUTION.cleanupTimeoutMs,
    ),
    maxSnapshotBytes: optionalBoundedIntegerField(
      input,
      'maxSnapshotBytes',
      '$.execution',
      1,
      MANIFEST_HARD_LIMITS.maxSnapshotBytes,
      DEFAULT_EXECUTION.maxSnapshotBytes,
    ),
    maxSnapshotEntries: optionalBoundedIntegerField(
      input,
      'maxSnapshotEntries',
      '$.execution',
      1,
      MANIFEST_HARD_LIMITS.maxSnapshotEntries,
      DEFAULT_EXECUTION.maxSnapshotEntries,
    ),
    maxSnapshotFileBytes: optionalBoundedIntegerField(
      input,
      'maxSnapshotFileBytes',
      '$.execution',
      1,
      MANIFEST_HARD_LIMITS.maxSnapshotFileBytes,
      DEFAULT_EXECUTION.maxSnapshotFileBytes,
    ),
    maxStderrBytes: optionalBoundedIntegerField(
      input,
      'maxStderrBytes',
      '$.execution',
      0,
      MANIFEST_HARD_LIMITS.maxStderrBytes,
      DEFAULT_EXECUTION.maxStderrBytes,
    ),
    maxStdinBytes: optionalBoundedIntegerField(
      input,
      'maxStdinBytes',
      '$.execution',
      0,
      MANIFEST_HARD_LIMITS.maxStdinBytes,
      DEFAULT_EXECUTION.maxStdinBytes,
    ),
    maxStdoutBytes: optionalBoundedIntegerField(
      input,
      'maxStdoutBytes',
      '$.execution',
      0,
      MANIFEST_HARD_LIMITS.maxStdoutBytes,
      DEFAULT_EXECUTION.maxStdoutBytes,
    ),
    stepTimeoutMs: optionalBoundedIntegerField(
      input,
      'stepTimeoutMs',
      '$.execution',
      MANIFEST_HARD_LIMITS.minTimeoutMs,
      MANIFEST_HARD_LIMITS.maxCommandTimeoutMs,
      DEFAULT_EXECUTION.stepTimeoutMs,
    ),
    suiteTimeoutMs: optionalBoundedIntegerField(
      input,
      'suiteTimeoutMs',
      '$.execution',
      1_000,
      MANIFEST_HARD_LIMITS.maxSuiteTimeoutMs,
      DEFAULT_EXECUTION.suiteTimeoutMs,
    ),
  };

  if (
    execution.stepTimeoutMs > execution.caseTimeoutMs ||
    execution.caseTimeoutMs > execution.armTimeoutMs ||
    execution.armTimeoutMs > execution.suiteTimeoutMs
  ) {
    throw new ConfigError(
      '$.execution timeouts must satisfy stepTimeoutMs <= caseTimeoutMs <= armTimeoutMs <= suiteTimeoutMs.',
    );
  }
  if (execution.maxSnapshotFileBytes > execution.maxSnapshotBytes) {
    throw new ConfigError('$.execution.maxSnapshotFileBytes must not exceed maxSnapshotBytes.');
  }
  return execution;
}

function parseEnvironment(value: unknown, stateRootIds: ReadonlySet<string>): EnvironmentSpec {
  if (value === undefined) {
    return DEFAULT_ENVIRONMENT;
  }
  const input = requireObject(value, '$.environment');
  assertKnownFields(input, environmentFields, '$.environment');
  const inherit = parseEnvironmentNames(
    optionalValue(input, 'inherit') ?? [],
    '$.environment.inherit',
    'inherit',
    MANIFEST_HARD_LIMITS.maxInheritedEnv,
  );
  const patch = parseEnvironmentPatch(input, '$.environment', stateRootIds, true);
  assertDisjointEnvironmentNames(inherit, patch.set, patch.unset, '$.environment');
  if (
    inherit.length + Object.keys(patch.set).length + patch.unset.length >
    MANIFEST_HARD_LIMITS.maxEnvEntries
  ) {
    throw new ConfigError(
      `$.environment may reference at most ${String(
        MANIFEST_HARD_LIMITS.maxEnvEntries,
      )} environment variables.`,
    );
  }
  return {
    inherit,
    set: patch.set,
    unset: patch.unset,
  };
}

function parseAdapter(
  value: unknown,
  stateRootIds: ReadonlySet<string>,
  defaultStateRoot: string,
  execution: ExecutionSpec,
): AdapterSpec {
  const input = requireObject(value, '$.adapter');
  assertKnownFields(input, adapterFields, '$.adapter');
  return {
    oracle: parseOracle(
      optionalValue(input, 'oracle') ?? { kind: 'exitCodeEquals', value: 0 },
      '$.adapter.oracle',
    ),
    reset: parseCommandList(
      optionalValue(input, 'reset') ?? [],
      '$.adapter.reset',
      MANIFEST_HARD_LIMITS.maxSetupCommands,
      stateRootIds,
      defaultStateRoot,
      execution,
    ),
    run: parseCommand(
      requireField(input, 'run', '$.adapter'),
      '$.adapter.run',
      stateRootIds,
      defaultStateRoot,
      execution,
    ),
    setup: parseCommandList(
      optionalValue(input, 'setup') ?? [],
      '$.adapter.setup',
      MANIFEST_HARD_LIMITS.maxSetupCommands,
      stateRootIds,
      defaultStateRoot,
      execution,
    ),
    snapshot: parseSnapshot(requireField(input, 'snapshot', '$.adapter'), stateRootIds),
  };
}

function parseCases(
  value: unknown,
  stateRootIds: ReadonlySet<string>,
  defaultStateRoot: string,
  execution: ExecutionSpec,
  adapterArgv: readonly ValueSpec[],
): readonly CaseSpec[] {
  const entries = requireArray(value, '$.cases');
  requireArrayLength(
    entries,
    '$.cases',
    MANIFEST_HARD_LIMITS.minCases,
    MANIFEST_HARD_LIMITS.maxCases,
  );
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    const jsonPath = `$.cases[${String(index)}]`;
    const input = requireObject(entry, jsonPath);
    assertKnownFields(input, caseFields, jsonPath);
    const id = parseId(requireField(input, 'id', jsonPath), `${jsonPath}.id`);
    if (ids.has(id)) {
      throw new ConfigError('Manifest case IDs must be unique.');
    }
    ids.add(id);

    const run = parseRunPatch(
      optionalValue(input, 'run'),
      `${jsonPath}.run`,
      stateRootIds,
      execution,
    );
    assertArgvLimits([...adapterArgv, ...run.argv], `${jsonPath}.run.argv`);

    const result: CaseSpec = {
      description: optionalDescription(input, 'description', jsonPath),
      id,
      platforms: parsePlatforms(optionalValue(input, 'platforms'), `${jsonPath}.platforms`),
      run,
      setup: parseCommandList(
        optionalValue(input, 'setup') ?? [],
        `${jsonPath}.setup`,
        MANIFEST_HARD_LIMITS.maxCaseSetupCommands,
        stateRootIds,
        defaultStateRoot,
        execution,
      ),
      tags: parseTags(optionalValue(input, 'tags'), `${jsonPath}.tags`),
      ...(Object.hasOwn(input, 'oracle')
        ? { oracle: parseOracle(input.oracle, `${jsonPath}.oracle`) }
        : {}),
    };
    return result;
  });
}

function parseCommandList(
  value: unknown,
  jsonPath: string,
  maximum: number,
  stateRootIds: ReadonlySet<string>,
  defaultStateRoot: string,
  execution: ExecutionSpec,
): readonly CommandSpec[] {
  const entries = requireArray(value, jsonPath);
  requireArrayLength(entries, jsonPath, 0, maximum);
  return entries.map((entry, index) =>
    parseCommand(entry, `${jsonPath}[${String(index)}]`, stateRootIds, defaultStateRoot, execution),
  );
}

function parseCommand(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
  defaultStateRoot: string,
  execution: ExecutionSpec,
): CommandSpec {
  const input = requireObject(value, jsonPath);
  assertKnownFields(input, commandFields, jsonPath);
  const argv = parseArgv(optionalValue(input, 'argv') ?? [], `${jsonPath}.argv`, stateRootIds);
  return {
    argv,
    cwd:
      optionalValue(input, 'cwd') === undefined
        ? {
            base: 'state',
            path: parsePortablePath('.', `${jsonPath}.cwd.path`),
            root: defaultStateRoot,
          }
        : parseWorkingDirectory(input.cwd, `${jsonPath}.cwd`, stateRootIds),
    env: parseEnvironmentPatch(optionalValue(input, 'env'), `${jsonPath}.env`, stateRootIds, false),
    program: parseProgram(requireField(input, 'program', jsonPath), `${jsonPath}.program`),
    stdin: parseStdin(optionalValue(input, 'stdin'), `${jsonPath}.stdin`, stateRootIds, execution),
    timeoutMs: optionalBoundedIntegerField(
      input,
      'timeoutMs',
      jsonPath,
      MANIFEST_HARD_LIMITS.minTimeoutMs,
      execution.stepTimeoutMs,
      execution.stepTimeoutMs,
    ),
  };
}

function parseRunPatch(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
  execution: ExecutionSpec,
): RunPatch {
  if (value === undefined) {
    return {
      argv: [],
      env: EMPTY_ENV_PATCH,
    };
  }
  const input = requireObject(value, jsonPath);
  assertKnownFields(input, runPatchFields, jsonPath);
  return {
    argv: parseArgv(optionalValue(input, 'argv') ?? [], `${jsonPath}.argv`, stateRootIds),
    env: parseEnvironmentPatch(optionalValue(input, 'env'), `${jsonPath}.env`, stateRootIds, false),
    ...(Object.hasOwn(input, 'cwd')
      ? { cwd: parseWorkingDirectory(input.cwd, `${jsonPath}.cwd`, stateRootIds) }
      : {}),
    ...(Object.hasOwn(input, 'stdin')
      ? { stdin: parseStdin(input.stdin, `${jsonPath}.stdin`, stateRootIds, execution) }
      : {}),
    ...(Object.hasOwn(input, 'timeoutMs')
      ? {
          timeoutMs: requireBoundedIntegerField(
            input,
            'timeoutMs',
            jsonPath,
            MANIFEST_HARD_LIMITS.minTimeoutMs,
            execution.stepTimeoutMs,
          ),
        }
      : {}),
  };
}

function parseProgram(value: unknown, jsonPath: string): ProgramSpec {
  const input = requireObject(value, jsonPath);
  if (Object.hasOwn(input, 'lookup')) {
    assertKnownFields(input, programLookupFields, jsonPath);
    const lookup = requireStringField(input, 'lookup', jsonPath);
    if (
      !executableLookupPattern.test(lookup) ||
      lookup === '.' ||
      lookup === '..' ||
      /\.(?:bat|cmd|ps1)$/iu.test(lookup) ||
      isWindowsDeviceName(lookup)
    ) {
      throw new ConfigError(
        `${jsonPath}.lookup must be a portable bare executable name of at most 64 ASCII characters.`,
      );
    }
    return { lookup };
  }
  if (Object.hasOwn(input, 'path')) {
    assertKnownFields(input, programPathFields, jsonPath);
    const path = parsePortablePath(requireField(input, 'path', jsonPath), `${jsonPath}.path`);
    if (path === '.') {
      throw new ConfigError(`${jsonPath}.path must identify a suite-relative executable file.`);
    }
    return { path };
  }
  throw new ConfigError(`${jsonPath} must contain exactly one of 'lookup' or 'path'.`);
}

function parseArgv(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
): readonly ValueSpec[] {
  const entries = requireArray(value, jsonPath);
  requireArrayLength(entries, jsonPath, 0, MANIFEST_HARD_LIMITS.maxArgs);
  const result = entries.map((entry, index) =>
    parseValueSpec(entry, `${jsonPath}[${String(index)}]`, stateRootIds),
  );
  assertArgvLimits(result, jsonPath);
  return result;
}

function assertArgvLimits(values: readonly ValueSpec[], jsonPath: string): void {
  if (values.length > MANIFEST_HARD_LIMITS.maxArgs) {
    throw new ConfigError(
      `${jsonPath} must contain at most ${String(MANIFEST_HARD_LIMITS.maxArgs)} arguments.`,
    );
  }
  let totalBytes = 0;
  for (const value of values) {
    const bytes =
      typeof value === 'string'
        ? Buffer.byteLength(value, 'utf8')
        : Buffer.byteLength(
            `${value.path.base}:${value.path.root ?? ''}:${value.path.path}`,
            'utf8',
          );
    if (bytes > MANIFEST_HARD_LIMITS.maxArgBytes) {
      throw new ConfigError(
        `${jsonPath} contains an argument exceeding ${String(
          MANIFEST_HARD_LIMITS.maxArgBytes,
        )} bytes.`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MANIFEST_HARD_LIMITS.maxArgvBytes) {
    throw new ConfigError(
      `${jsonPath} exceeds the ${String(MANIFEST_HARD_LIMITS.maxArgvBytes)}-byte argv limit.`,
    );
  }
}

function parseValueSpec(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
): ValueSpec {
  if (typeof value === 'string') {
    return requireBoundedString(value, jsonPath, MANIFEST_HARD_LIMITS.maxValueBytes, true);
  }
  const input = requireObject(value, jsonPath);
  assertKnownFields(input, new Set(['path']), jsonPath);
  return {
    path: parsePathReference(
      requireField(input, 'path', jsonPath),
      `${jsonPath}.path`,
      stateRootIds,
      new Set(['state', 'suite', 'temp']),
    ),
  };
}

function parseWorkingDirectory(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
): WorkingDirectorySpec {
  const reference = parsePathReference(value, jsonPath, stateRootIds, new Set(['state', 'temp']));
  if (reference.base === 'suite') {
    throw new ConfigError(`${jsonPath}.base must equal 'state' or 'temp'.`);
  }
  if (reference.base === 'state') {
    const root = reference.root;
    if (root === undefined) {
      throw new ConfigError(`${jsonPath}.root is required when base equals 'state'.`);
    }
    return {
      base: reference.base,
      path: reference.path,
      root,
    };
  }
  return {
    base: reference.base,
    path: reference.path,
  };
}

function parsePathReference(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
  allowedBases: ReadonlySet<PathReference['base']>,
): PathReference {
  const input = requireObject(value, jsonPath);
  assertKnownFields(input, pathReferenceFields, jsonPath);
  const base = requireStringField(input, 'base', jsonPath);
  if (base !== 'state' && base !== 'suite' && base !== 'temp') {
    throw new ConfigError(`${jsonPath}.base must equal 'state', 'suite', or 'temp'.`);
  }
  if (!allowedBases.has(base)) {
    throw new ConfigError(`${jsonPath}.base is not allowed in this command field.`);
  }
  const path = parsePortablePath(requireField(input, 'path', jsonPath), `${jsonPath}.path`);
  if (base === 'state') {
    const root = parseId(requireField(input, 'root', jsonPath), `${jsonPath}.root`);
    if (!stateRootIds.has(root)) {
      throw new ConfigError(`${jsonPath}.root references unknown state root '${root}'.`);
    }
    return { base, path, root };
  }
  if (Object.hasOwn(input, 'root')) {
    throw new ConfigError(`${jsonPath}.root is allowed only when base equals 'state'.`);
  }
  return { base, path };
}

function parseEnvironmentPatch(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
  alreadyValidatedObject: boolean,
): EnvironmentPatch {
  if (value === undefined) {
    return EMPTY_ENV_PATCH;
  }
  const input = alreadyValidatedObject ? (value as UnknownObject) : requireObject(value, jsonPath);
  if (!alreadyValidatedObject) {
    assertKnownFields(input, environmentPatchFields, jsonPath);
  }

  const set = parseEnvironmentSet(
    optionalValue(input, 'set') ?? {},
    `${jsonPath}.set`,
    stateRootIds,
  );
  const unset = parseEnvironmentNames(
    optionalValue(input, 'unset') ?? [],
    `${jsonPath}.unset`,
    'unset',
    MANIFEST_HARD_LIMITS.maxEnvEntries,
  );
  assertDisjointEnvironmentNames([], set, unset, jsonPath);
  if (Object.keys(set).length + unset.length > MANIFEST_HARD_LIMITS.maxEnvEntries) {
    throw new ConfigError(
      `${jsonPath} may reference at most ${String(MANIFEST_HARD_LIMITS.maxEnvEntries)} environment variables.`,
    );
  }
  return { set, unset };
}

function parseEnvironmentSet(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
): Readonly<Record<string, ValueSpec>> {
  const input = requireObject(value, jsonPath);
  const keys = Object.keys(input);
  if (keys.length > MANIFEST_HARD_LIMITS.maxEnvEntries) {
    throw new ConfigError(
      `${jsonPath} may contain at most ${String(MANIFEST_HARD_LIMITS.maxEnvEntries)} entries.`,
    );
  }
  const result: Record<string, ValueSpec> = Object.create(null) as Record<string, ValueSpec>;
  const canonical = new Set<string>();
  let totalBytes = 0;
  for (const key of keys) {
    const name = parseEnvironmentName(key, `${jsonPath}.${key}`, 'set');
    const folded = foldEnvironmentName(name);
    if (canonical.has(folded)) {
      throw new ConfigError(`${jsonPath} contains duplicate environment names by ASCII case.`);
    }
    canonical.add(folded);
    const parsed = parseValueSpec(input[key], `${jsonPath}.${key}`, stateRootIds);
    totalBytes += Buffer.byteLength(name, 'utf8') + valueSpecBytes(parsed);
    result[name] = parsed;
  }
  if (totalBytes > MANIFEST_HARD_LIMITS.maxEnvironmentBytes) {
    throw new ConfigError(
      `${jsonPath} exceeds the ${String(MANIFEST_HARD_LIMITS.maxEnvironmentBytes)}-byte environment limit.`,
    );
  }
  return result;
}

function parseEnvironmentNames(
  value: unknown,
  jsonPath: string,
  mode: 'inherit' | 'unset',
  maximum: number,
): readonly string[] {
  const entries = requireArray(value, jsonPath);
  requireArrayLength(entries, jsonPath, 0, maximum);
  const names: string[] = [];
  const canonical = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const name = parseEnvironmentName(entry, `${jsonPath}[${String(index)}]`, mode);
    const folded = foldEnvironmentName(name);
    if (canonical.has(folded)) {
      throw new ConfigError(`${jsonPath} contains duplicate environment names by ASCII case.`);
    }
    canonical.add(folded);
    names.push(name);
  }
  return names;
}

function parseEnvironmentName(
  value: unknown,
  jsonPath: string,
  mode: 'inherit' | 'set' | 'unset',
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MANIFEST_HARD_LIMITS.maxEnvNameCharacters ||
    !environmentNamePattern.test(value)
  ) {
    throw new ConfigError(`${jsonPath} must be a portable environment variable name.`);
  }
  const canonical = foldEnvironmentName(value);
  if (
    mode !== 'unset' &&
    (forbiddenEnvironmentNames.has(canonical) ||
      canonical.startsWith('DYLD_') ||
      canonical.startsWith('GHOSTCASE_'))
  ) {
    throw new ConfigError(`${jsonPath} names a forbidden environment variable.`);
  }
  return value;
}

function assertDisjointEnvironmentNames(
  inherit: readonly string[],
  set: Readonly<Record<string, ValueSpec>>,
  unset: readonly string[],
  jsonPath: string,
): void {
  const seen = new Set<string>();
  for (const name of [...inherit, ...Object.keys(set), ...unset]) {
    const folded = foldEnvironmentName(name);
    if (seen.has(folded)) {
      throw new ConfigError(
        `${jsonPath} must not inherit, set, or unset the same environment name.`,
      );
    }
    seen.add(folded);
  }
}

function parseStdin(
  value: unknown,
  jsonPath: string,
  stateRootIds: ReadonlySet<string>,
  execution: ExecutionSpec,
): StdinSpec {
  if (value === undefined) {
    return { kind: 'none' };
  }
  const input = requireObject(value, jsonPath);
  const kind = requireStringField(input, 'kind', jsonPath);
  if (kind === 'none') {
    assertKnownFields(input, stdinNoneFields, jsonPath);
    return { kind };
  }
  if (kind === 'text') {
    assertKnownFields(input, stdinTextFields, jsonPath);
    return {
      kind,
      value: requireBoundedString(
        requireField(input, 'value', jsonPath),
        `${jsonPath}.value`,
        Math.min(execution.maxStdinBytes, MANIFEST_HARD_LIMITS.maxTextBytes),
        true,
      ),
    };
  }
  if (kind === 'file') {
    assertKnownFields(input, stdinFileFields, jsonPath);
    const pathValue = requireObject(requireField(input, 'path', jsonPath), `${jsonPath}.path`);
    assertKnownFields(pathValue, new Set(['path']), `${jsonPath}.path`);
    return {
      kind,
      path: {
        path: parsePathReference(
          requireField(pathValue, 'path', `${jsonPath}.path`),
          `${jsonPath}.path.path`,
          stateRootIds,
          new Set(['state', 'suite', 'temp']),
        ),
      },
    };
  }
  throw new ConfigError(`${jsonPath}.kind must equal 'none', 'text', or 'file'.`);
}

function parseSnapshot(value: unknown, stateRootIds: ReadonlySet<string>): SnapshotSpec {
  const input = requireObject(value, '$.adapter.snapshot');
  assertKnownFields(input, snapshotFields, '$.adapter.snapshot');
  const roots = requireArray(
    requireField(input, 'roots', '$.adapter.snapshot'),
    '$.adapter.snapshot.roots',
  );
  requireArrayLength(roots, '$.adapter.snapshot.roots', 1, MANIFEST_HARD_LIMITS.maxStateRoots);
  const seen = new Set<string>();
  return {
    roots: roots.map((entry, index) => {
      const jsonPath = `$.adapter.snapshot.roots[${String(index)}]`;
      const root = requireObject(entry, jsonPath);
      assertKnownFields(root, snapshotRootFields, jsonPath);
      const id = parseId(requireField(root, 'root', jsonPath), `${jsonPath}.root`);
      if (!stateRootIds.has(id)) {
        throw new ConfigError(`${jsonPath}.root references unknown state root '${id}'.`);
      }
      if (seen.has(id)) {
        throw new ConfigError('Snapshot root IDs must be unique.');
      }
      seen.add(id);
      return {
        root: id,
      };
    }),
  };
}

function parsePlatforms(value: unknown, jsonPath: string): readonly PlatformName[] {
  if (value === undefined) {
    return ['win32', 'linux'];
  }
  const entries = requireArray(value, jsonPath);
  requireArrayLength(entries, jsonPath, 1, platformNames.size);
  const seen = new Set<PlatformName>();
  return entries.map((entry, index) => {
    if (typeof entry !== 'string' || !platformNames.has(entry as PlatformName)) {
      throw new ConfigError(`${jsonPath}[${String(index)}] must equal 'win32' or 'linux'.`);
    }
    const platform = entry as PlatformName;
    if (seen.has(platform)) {
      throw new ConfigError(`${jsonPath} must not contain duplicate platforms.`);
    }
    seen.add(platform);
    return platform;
  });
}

function parseTags(value: unknown, jsonPath: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const entries = requireArray(value, jsonPath);
  requireArrayLength(entries, jsonPath, 0, MANIFEST_HARD_LIMITS.maxTags);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const tag = parseId(entry, `${jsonPath}[${String(index)}]`);
    if (seen.has(tag)) {
      throw new ConfigError(`${jsonPath} must not contain duplicate tags.`);
    }
    seen.add(tag);
    return tag;
  });
}

function parseOracle(value: unknown, jsonPath: string): OracleSpec {
  return parseOracleNode(value, jsonPath, 0, {
    active: new WeakSet<object>(),
    nodes: 0,
  });
}

function parseOracleNode(
  value: unknown,
  jsonPath: string,
  depth: number,
  state: OracleParseState,
): OracleSpec {
  if (depth > MANIFEST_HARD_LIMITS.maxOracleDepth) {
    throw new ConfigError(
      `${jsonPath} exceeds the OracleSpec depth limit of ${String(
        MANIFEST_HARD_LIMITS.maxOracleDepth,
      )}.`,
    );
  }
  const input = requireObject(value, jsonPath);
  if (state.active.has(input)) {
    throw new ConfigError(`${jsonPath} must not contain a cycle.`);
  }
  state.nodes += 1;
  if (state.nodes > MANIFEST_HARD_LIMITS.maxOracleNodes) {
    throw new ConfigError(
      `${jsonPath} exceeds the OracleSpec node limit of ${String(
        MANIFEST_HARD_LIMITS.maxOracleNodes,
      )}.`,
    );
  }

  state.active.add(input);
  try {
    const kind = requireStringField(input, 'kind', jsonPath);
    switch (kind) {
      case 'exitCodeEquals': {
        assertKnownFields(input, new Set(['kind', 'value']), jsonPath);
        return {
          kind,
          value: requireSafeIntegerField(input, 'value', jsonPath),
        };
      }
      case 'stdoutJsonPointerEquals': {
        assertKnownFields(input, new Set(['equals', 'kind', 'pointer']), jsonPath);
        return {
          equals: cloneExpectedJson(requireField(input, 'equals', jsonPath), `${jsonPath}.equals`),
          kind,
          pointer: parseJsonPointer(
            requireField(input, 'pointer', jsonPath),
            `${jsonPath}.pointer`,
          ),
        };
      }
      case 'fileJsonPointerEquals': {
        assertKnownFields(input, new Set(['equals', 'kind', 'path', 'pointer']), jsonPath);
        const path = parsePortablePath(requireField(input, 'path', jsonPath), `${jsonPath}.path`);
        if (path === '.') {
          throw new ConfigError(`${jsonPath}.path must identify a JSON file.`);
        }
        return {
          equals: cloneExpectedJson(requireField(input, 'equals', jsonPath), `${jsonPath}.equals`),
          kind,
          path,
          pointer: parseJsonPointer(
            requireField(input, 'pointer', jsonPath),
            `${jsonPath}.pointer`,
          ),
        };
      }
      case 'all':
      case 'any': {
        assertKnownFields(input, new Set(['kind', 'rules']), jsonPath);
        const rules = requireArray(requireField(input, 'rules', jsonPath), `${jsonPath}.rules`);
        requireArrayLength(rules, `${jsonPath}.rules`, 1, MANIFEST_HARD_LIMITS.maxOracleRules);
        return {
          kind,
          rules: rules.map((rule, index) =>
            parseOracleNode(rule, `${jsonPath}.rules[${String(index)}]`, depth + 1, state),
          ),
        };
      }
      case 'not': {
        assertKnownFields(input, new Set(['kind', 'rule']), jsonPath);
        return {
          kind,
          rule: parseOracleNode(
            requireField(input, 'rule', jsonPath),
            `${jsonPath}.rule`,
            depth + 1,
            state,
          ),
        };
      }
      default:
        throw new ConfigError(`${jsonPath}.kind names an unsupported OracleSpec variant.`);
    }
  } finally {
    state.active.delete(input);
  }
}

function cloneExpectedJson(value: unknown, jsonPath: string): JsonValue {
  try {
    assertJsonValue(value, jsonPath);
    assertSafeJsonNumbers(value, jsonPath);
    return parseStrictJson(canonicalizeJson(value));
  } catch (error) {
    throw new ConfigError(`${jsonPath} must be a bounded, strict JSON value.`, {
      cause: error,
    });
  }
}

function assertSafeJsonNumbers(value: JsonValue, jsonPath: string): void {
  if (typeof value === 'number') {
    if (Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ConfigError(`${jsonPath} contains an unsafe JSON number.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    for (const [index, entry] of entries.entries()) {
      assertSafeJsonNumbers(entry, `${jsonPath}[${String(index)}]`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenJsonKeys.has(key)) {
      throw new ConfigError(`${jsonPath} contains a forbidden object key.`);
    }
    assertSafeJsonNumbers(entry, `${jsonPath}.${key}`);
  }
}

function parseJsonPointer(value: unknown, jsonPath: string): string {
  const pointer = requireBoundedString(value, jsonPath, 2048, true);
  try {
    validateJsonPointer(pointer);
  } catch (error) {
    if (error instanceof JsonPointerError) {
      throw new ConfigError(`${jsonPath} must be a valid JSON Pointer.`, { cause: error });
    }
    throw error;
  }
  return pointer;
}

async function readManifestFile(sourcePath: string): Promise<Uint8Array> {
  let before: BigIntStats;
  let canonical: string;
  try {
    before = await lstat(sourcePath, { bigint: true });
    canonical = await realpath(sourcePath);
  } catch (error) {
    throw new ConfigError(
      `Unable to inspect manifest file '${sourcePath}': ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!before.isFile() || before.isSymbolicLink() || !samePath(sourcePath, canonical)) {
    throw new ConfigError(`Manifest path '${sourcePath}' must be a regular non-link file.`);
  }
  if (before.size > BigInt(MANIFEST_FILE_MAX_BYTES)) {
    throw manifestSizeError(sourcePath);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(sourcePath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      throw new ConfigError(`Manifest file '${sourcePath}' changed before it could be read.`);
    }

    const bytes = await readBounded(handle, sourcePath);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(before, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw new ConfigError(`Manifest file '${sourcePath}' changed while it was read.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Unable to read manifest file '${sourcePath}': ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle, sourcePath: string): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(MANIFEST_FILE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    if (offset > MANIFEST_FILE_MAX_BYTES) {
      throw manifestSizeError(sourcePath);
    }
  }
  return Buffer.from(buffer.subarray(0, offset));
}

function manifestSizeError(sourcePath: string): ConfigError {
  return new ConfigError(
    `Manifest file '${sourcePath}' exceeds the ${String(MANIFEST_FILE_MAX_BYTES)}-byte limit.`,
  );
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function parseId(value: unknown, jsonPath: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new ConfigError(`${jsonPath} must match ^[a-z][a-z0-9_-]{0,63}$.`);
  }
  return value;
}

function optionalDescription(input: UnknownObject, field: string, parentPath: string): string {
  const value = optionalValue(input, field);
  return value === undefined
    ? ''
    : requireBoundedString(
        value,
        `${parentPath}.${field}`,
        MANIFEST_HARD_LIMITS.maxDescriptionBytes,
        true,
      );
}

function requireBoundedString(
  value: unknown,
  jsonPath: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string') {
    throw new ConfigError(`${jsonPath} must be a string.`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new ConfigError(`${jsonPath} must not be empty.`);
  }
  if (value.includes('\0') || containsLoneSurrogate(value)) {
    throw new ConfigError(`${jsonPath} must contain only Unicode scalar values without NUL.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ConfigError(`${jsonPath} exceeds the ${String(maxBytes)}-byte limit.`);
  }
  return value;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireObject(value: unknown, jsonPath: string): UnknownObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${jsonPath} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigError(`${jsonPath} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConfigError(`${jsonPath} must not contain symbol properties.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new ConfigError(`${jsonPath} must contain only enumerable data properties.`);
    }
  }
  return value as UnknownObject;
}

function requireArray(value: unknown, jsonPath: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${jsonPath} must be an array.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConfigError(`${jsonPath} must not contain symbol properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const extraKeys = Object.keys(descriptors).filter(
    (key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key),
  );
  if (extraKeys.length > 0) {
    throw new ConfigError(`${jsonPath} must not contain non-array properties.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new ConfigError(`${jsonPath} must not contain holes or accessors.`);
    }
  }
  return value;
}

function requireArrayLength(
  value: readonly unknown[],
  jsonPath: string,
  minimum: number,
  maximum: number,
): void {
  if (value.length < minimum || value.length > maximum) {
    throw new ConfigError(
      `${jsonPath} must contain between ${String(minimum)} and ${String(maximum)} entries.`,
    );
  }
}

function assertKnownFields(
  input: UnknownObject,
  allowedFields: ReadonlySet<string>,
  jsonPath: string,
): void {
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      throw new ConfigError(`${jsonPath} contains unknown field '${field}'.`);
    }
  }
}

function requireField(input: UnknownObject, field: string, parentPath: string): unknown {
  if (!Object.hasOwn(input, field)) {
    throw new ConfigError(`${parentPath}.${field} is required.`);
  }
  return input[field];
}

function optionalValue(input: UnknownObject, field: string): unknown {
  return Object.hasOwn(input, field) ? input[field] : undefined;
}

function requireStringField(input: UnknownObject, field: string, parentPath: string): string {
  return requireBoundedString(
    requireField(input, field, parentPath),
    `${parentPath}.${field}`,
    MANIFEST_HARD_LIMITS.maxValueBytes,
    true,
  );
}

function requireSafeIntegerField(input: UnknownObject, field: string, parentPath: string): number {
  const value = requireField(input, field, parentPath);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new ConfigError(`${parentPath}.${field} must be a safe integer.`);
  }
  return value;
}

function requireBoundedIntegerField(
  input: UnknownObject,
  field: string,
  parentPath: string,
  minimum: number,
  maximum: number,
): number {
  const value = requireField(input, field, parentPath);
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ConfigError(
      `${parentPath}.${field} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}

function optionalBoundedIntegerField(
  input: UnknownObject,
  field: string,
  parentPath: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  return Object.hasOwn(input, field)
    ? requireBoundedIntegerField(input, field, parentPath, minimum, maximum)
    : defaultValue;
}

function foldEnvironmentName(value: string): string {
  return value.toUpperCase();
}

function valueSpecBytes(value: ValueSpec): number {
  return typeof value === 'string'
    ? Buffer.byteLength(value, 'utf8')
    : Buffer.byteLength(`${value.path.base}:${value.path.root ?? ''}:${value.path.path}`, 'utf8');
}

function isWindowsDeviceName(value: string): boolean {
  const basename = value.split('.')[0]?.trimEnd().toUpperCase() ?? '';
  return /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(basename);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
