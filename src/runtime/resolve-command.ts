import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, relative, resolve } from 'node:path';

import { ConfigError, HarnessError, isNodeError } from '../domain/errors.js';
import type {
  CommandSpec,
  EnvironmentPatch,
  EnvironmentSpec,
  PathReference,
  ProgramSpec,
  RunPatch,
  StdinSpec,
  ValueSpec,
  WorkingDirectorySpec,
} from '../domain/model.js';
import { resolvePortablePath } from '../config/portable-path.js';

const WINDOWS_COMMAND_LINE_LIMIT = 30_000;

export interface CommandResolutionContext {
  readonly armRoot: string;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly maxStdinBytes: number;
  readonly stateRoots: ReadonlyMap<string, string>;
  readonly suiteDir: string;
  readonly tempRoot: string;
}

export interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Buffer | null;
  readonly timeoutMs: number;
}

export interface CommandMetadataValidationOptions {
  readonly allowUnmaterializedDynamicStdin?: boolean;
}

interface ResolvedCommandWithoutStdin {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

type StdinMetadata =
  | {
      readonly kind: 'file';
      readonly filename: string;
      readonly snapshot: BigIntStats;
    }
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'text';
      readonly byteLength: number;
      readonly value: string;
    };

interface ResolvedPathLocation {
  readonly filename: string;
  readonly root: string;
}

export function mergeRunCommand(base: CommandSpec, patch: RunPatch): CommandSpec {
  return {
    argv: Object.freeze([...base.argv, ...patch.argv]),
    cwd: patch.cwd ?? base.cwd,
    env: mergeEnvironmentPatches(base.env, patch.env),
    program: base.program,
    stdin: patch.stdin ?? base.stdin,
    timeoutMs: patch.timeoutMs ?? base.timeoutMs,
  };
}

export async function resolveCommand(
  command: CommandSpec,
  environment: EnvironmentSpec,
  context: CommandResolutionContext,
): Promise<ResolvedCommand> {
  const resolved = await resolveCommandWithoutStdin(command, environment, context);
  const stdin = await resolveStdin(command.stdin, context);
  return {
    ...resolved,
    stdin,
  };
}

export async function validateCommandMetadata(
  command: CommandSpec,
  environment: EnvironmentSpec,
  context: CommandResolutionContext,
  options: Readonly<CommandMetadataValidationOptions> = {},
): Promise<void> {
  await resolveCommandWithoutStdin(command, environment, context);
  if (
    options.allowUnmaterializedDynamicStdin === true &&
    (await isUnmaterializedDynamicStdin(command.stdin, context))
  ) {
    return;
  }
  await inspectStdin(command.stdin, context);
}

async function resolveCommandWithoutStdin(
  command: CommandSpec,
  environment: EnvironmentSpec,
  context: CommandResolutionContext,
): Promise<ResolvedCommandWithoutStdin> {
  const executable = await resolveProgram(command.program, context);
  const argumentsList = command.argv.map((value) => resolveValue(value, context));
  const argv = Object.freeze([executable, ...argumentsList]);
  validateCommandLineSize(argv);
  const cwd = await resolveWorkingDirectory(command.cwd, context);
  const env = Object.freeze(resolveEnvironment(environment, command.env, context));
  return {
    argv,
    cwd,
    env,
    timeoutMs: command.timeoutMs,
  };
}

export function resolveValue(value: ValueSpec, context: CommandResolutionContext): string {
  return typeof value === 'string' ? value : resolvePathReference(value.path, context);
}

export function resolvePathReference(
  reference: PathReference,
  context: CommandResolutionContext,
): string {
  return resolvePathLocation(reference, context).filename;
}

function resolvePathLocation(
  reference: PathReference,
  context: CommandResolutionContext,
): ResolvedPathLocation {
  switch (reference.base) {
    case 'suite':
      if (reference.root !== undefined) {
        throw new ConfigError('A suite path reference must not name a state root.');
      }
      return {
        filename: resolvePortablePath(context.suiteDir, reference.path),
        root: context.suiteDir,
      };
    case 'temp':
      if (reference.root !== undefined) {
        throw new ConfigError('A temp path reference must not name a state root.');
      }
      return {
        filename: resolvePortablePath(context.tempRoot, reference.path),
        root: context.tempRoot,
      };
    case 'state': {
      if (reference.root === undefined) {
        throw new ConfigError('A state path reference must name a state root.');
      }
      const root = context.stateRoots.get(reference.root);
      if (root === undefined) {
        throw new ConfigError('A path reference names an unknown state root.');
      }
      return {
        filename: resolvePortablePath(root, reference.path),
        root,
      };
    }
  }
}

async function resolveProgram(
  program: ProgramSpec,
  context: CommandResolutionContext,
): Promise<string> {
  if ('path' in program) {
    const candidate = resolvePortablePath(context.suiteDir, program.path);
    return validateExecutable(candidate, false);
  }
  if (program.lookup === 'node') {
    return validateExecutable(process.execPath, true);
  }
  return resolveLookup(program.lookup, context.hostEnvironment);
}

async function resolveLookup(
  name: string,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(name)) {
    throw new ConfigError('An executable lookup name is not portable.');
  }
  if (process.platform === 'win32' && /\.(?:bat|cmd|ps1)$/iu.test(name)) {
    throw new ConfigError('Windows command-script shims are not supported executables.');
  }
  const pathValue = readEnvironmentValue(hostEnvironment, 'PATH');
  if (pathValue === undefined || pathValue.length === 0) {
    throw new HarnessError('The host PATH required by an executable lookup is unavailable.');
  }

  const suffixes =
    process.platform === 'win32' && extname(name).length === 0 ? ['', '.exe', '.com'] : [''];
  const matches = new Map<string, string>();
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = unquotePathEntry(rawDirectory);
    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${name}${suffix}`);
      try {
        const executable = await validateExecutable(candidate, true);
        matches.set(pathKey(executable), executable);
      } catch {
        // A PATH candidate that is absent or not executable is not a match.
      }
    }
  }

  if (matches.size === 0) {
    throw new HarnessError('An explicitly requested host executable could not be resolved.');
  }
  if (matches.size > 1) {
    throw new HarnessError('An executable lookup resolved to multiple different host programs.');
  }
  const [resolved] = matches.values();
  if (resolved === undefined) {
    throw new HarnessError('An explicitly requested host executable could not be resolved.');
  }
  return resolved;
}

async function validateExecutable(candidate: string, allowLink: boolean): Promise<string> {
  let lexicalMetadata;
  let canonical;
  let canonicalMetadata;
  try {
    lexicalMetadata = await lstat(candidate);
    canonical = await realpath(candidate);
    canonicalMetadata = await lstat(canonical);
    if (process.platform !== 'win32') {
      await access(canonical, constants.X_OK);
    }
  } catch (error) {
    throw new HarnessError('An executable is missing or cannot be inspected.', { cause: error });
  }
  if (
    !canonicalMetadata.isFile() ||
    (!allowLink && (lexicalMetadata.isSymbolicLink() || !samePath(candidate, canonical)))
  ) {
    throw new HarnessError('An executable is not a permitted regular file.');
  }
  if (process.platform === 'win32' && /\.(?:bat|cmd|ps1)$/iu.test(canonical)) {
    throw new ConfigError('Windows command-script shims are not supported executables.');
  }
  return canonical;
}

async function resolveWorkingDirectory(
  location: WorkingDirectorySpec,
  context: CommandResolutionContext,
): Promise<string> {
  let base: string;
  if (location.base === 'temp') {
    if (location.root !== undefined) {
      throw new ConfigError('A temp working directory must not name a state root.');
    }
    base = context.tempRoot;
  } else {
    if (location.root === undefined) {
      throw new ConfigError('A state working directory must name a state root.');
    }
    const stateRoot = context.stateRoots.get(location.root);
    if (stateRoot === undefined) {
      throw new ConfigError('A working directory names an unknown state root.');
    }
    base = stateRoot;
  }
  const candidate = resolvePortablePath(base, location.path);
  let metadata;
  let canonical;
  try {
    metadata = await lstat(candidate);
    canonical = await realpath(candidate);
  } catch (error) {
    throw new HarnessError('A command working directory is unavailable.', { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(candidate, canonical)) {
    throw new HarnessError('A command working directory is not a regular isolated directory.');
  }
  if (!isWithin(context.armRoot, canonical)) {
    throw new HarnessError('A command working directory escaped its isolated arm.');
  }
  return canonical;
}

function resolveEnvironment(
  environment: EnvironmentSpec,
  commandPatch: EnvironmentPatch,
  context: CommandResolutionContext,
): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const name of environment.inherit) {
    const value = readEnvironmentValue(context.hostEnvironment, name);
    if (value === undefined) {
      throw new HarnessError('An explicitly inherited host environment variable is unavailable.');
    }
    setEnvironmentValue(output, name, value);
  }
  applyEnvironmentPatch(output, environment, context);
  applyEnvironmentPatch(output, commandPatch, context);

  setEnvironmentValue(output, 'GHOSTCASE', '1');
  setEnvironmentValue(output, 'HOME', context.tempRoot);
  setEnvironmentValue(output, 'TMP', context.tempRoot);
  setEnvironmentValue(output, 'TEMP', context.tempRoot);
  if (process.platform === 'win32') {
    setEnvironmentValue(output, 'USERPROFILE', context.tempRoot);
    const systemRoot =
      readEnvironmentValue(context.hostEnvironment, 'SystemRoot') ??
      readEnvironmentValue(context.hostEnvironment, 'WINDIR');
    if (systemRoot !== undefined) {
      setEnvironmentValue(output, 'SystemRoot', systemRoot);
      setEnvironmentValue(output, 'WINDIR', systemRoot);
    }
  }
  return output;
}

function applyEnvironmentPatch(
  output: Record<string, string>,
  patch: EnvironmentPatch,
  context: CommandResolutionContext,
): void {
  for (const name of patch.unset) {
    deleteEnvironmentValue(output, name);
  }
  for (const [name, value] of Object.entries(patch.set)) {
    setEnvironmentValue(output, name, resolveValue(value, context));
  }
}

function mergeEnvironmentPatches(
  base: EnvironmentPatch,
  patch: EnvironmentPatch,
): EnvironmentPatch {
  const set = new Map(Object.entries(base.set));
  const unset = new Set(base.unset);
  for (const name of patch.unset) {
    deleteCaseInsensitive(set, name);
    addCaseInsensitive(unset, name);
  }
  for (const [name, value] of Object.entries(patch.set)) {
    deleteCaseInsensitive(unset, name);
    setCaseInsensitive(set, name, value);
  }
  return {
    set: Object.freeze(Object.fromEntries(set)),
    unset: Object.freeze([...unset]),
  };
}

async function resolveStdin(
  stdin: StdinSpec,
  context: CommandResolutionContext,
): Promise<Buffer | null> {
  const metadata = await inspectStdin(stdin, context);
  if (metadata.kind === 'none') {
    return null;
  }
  if (metadata.kind === 'text') {
    const content = Buffer.from(metadata.value, 'utf8');
    if (content.length !== metadata.byteLength) {
      throw new HarnessError('Command stdin changed while it was prepared.');
    }
    return content;
  }

  return readStdinFile(metadata, context.maxStdinBytes);
}

async function inspectStdin(
  stdin: StdinSpec,
  context: CommandResolutionContext,
): Promise<StdinMetadata> {
  if (stdin.kind === 'none') {
    return { kind: stdin.kind };
  }
  if (stdin.kind === 'text') {
    const byteLength = Buffer.byteLength(stdin.value, 'utf8');
    assertStdinLimit(byteLength, context.maxStdinBytes);
    return { byteLength, kind: stdin.kind, value: stdin.value };
  }

  const location = resolvePathLocation(stdin.path.path, context);
  const before = await safeBigIntLstat(location.filename);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new HarnessError('A command stdin file is not a permitted regular non-link file.');
  }
  if (before.size > BigInt(context.maxStdinBytes)) {
    throw new HarnessError('A command stdin file exceeds its configured byte limit.');
  }

  const [canonicalRoot, canonicalFile] = await Promise.all([
    safeRealpath(location.root, 'root'),
    safeRealpath(location.filename, 'file'),
  ]);
  if (!isWithin(canonicalRoot, canonicalFile)) {
    throw new HarnessError('A command stdin file escaped its declared typed-path root.');
  }
  if (!samePath(location.filename, canonicalFile)) {
    throw new HarnessError('A command stdin file is not a permitted regular non-link file.');
  }
  const canonicalMetadata = await safeBigIntLstat(canonicalFile);
  if (!sameFileSnapshot(before, canonicalMetadata)) {
    throw new HarnessError('A command stdin file changed while its metadata was inspected.');
  }
  return {
    filename: canonicalFile,
    kind: stdin.kind,
    snapshot: before,
  };
}

async function isUnmaterializedDynamicStdin(
  stdin: StdinSpec,
  context: CommandResolutionContext,
): Promise<boolean> {
  if (stdin.kind !== 'file' || stdin.path.path.base === 'suite') {
    return false;
  }
  const location = resolvePathLocation(stdin.path.path, context);
  try {
    await lstat(location.filename);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return true;
    }
    throw new HarnessError('Unable to inspect a dynamic command stdin path.', { cause: error });
  }
}

async function readStdinFile(
  metadata: Extract<StdinMetadata, { readonly kind: 'file' }>,
  maxStdinBytes: number,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(metadata.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(metadata.snapshot, opened)) {
      throw new HarnessError('A command stdin file changed before it could be read.');
    }
    const content = await handle.readFile();
    assertStdinLimit(content.length, maxStdinBytes);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await safeBigIntLstat(metadata.filename);
    if (
      !sameFileSnapshot(metadata.snapshot, after) ||
      !sameFileSnapshot(metadata.snapshot, pathAfter)
    ) {
      throw new HarnessError('A command stdin file changed while it was read.');
    }
    return content;
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError('Unable to read a command stdin file.', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertStdinLimit(bytes: number, maximum: number): void {
  if (bytes > maximum) {
    throw new HarnessError('Command stdin exceeds its configured byte limit.');
  }
}

function validateCommandLineSize(argv: readonly string[]): void {
  if (process.platform !== 'win32') {
    return;
  }
  const conservativeUnits = argv.reduce((total, argument) => total + argument.length * 2 + 3, 0);
  if (conservativeUnits > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new ConfigError('The resolved command exceeds the Windows command-line limit.');
  }
}

function readEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  requestedName: string,
): string | undefined {
  if (process.platform !== 'win32') {
    return environment[requestedName];
  }
  const requestedKey = requestedName.toUpperCase();
  for (const [name, value] of Object.entries(environment)) {
    if (name.toUpperCase() === requestedKey) {
      return value;
    }
  }
  return undefined;
}

function setEnvironmentValue(
  environment: Record<string, string>,
  name: string,
  value: string,
): void {
  deleteEnvironmentValue(environment, name);
  environment[name] = value;
}

function deleteEnvironmentValue(environment: Record<string, string>, name: string): void {
  const key = caseInsensitiveKey(name);
  for (const existing of Object.keys(environment)) {
    if (caseInsensitiveKey(existing) === key) {
      Reflect.deleteProperty(environment, existing);
    }
  }
}

function setCaseInsensitive<T>(map: Map<string, T>, name: string, value: T): void {
  deleteCaseInsensitive(map, name);
  map.set(name, value);
}

function addCaseInsensitive(set: Set<string>, name: string): void {
  deleteCaseInsensitive(set, name);
  set.add(name);
}

function deleteCaseInsensitive<T>(collection: Map<string, T> | Set<string>, name: string): void {
  const key = caseInsensitiveKey(name);
  for (const existing of collection.keys()) {
    if (caseInsensitiveKey(existing) === key) {
      collection.delete(existing);
    }
  }
}

function caseInsensitiveKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

function unquotePathEntry(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function safeBigIntLstat(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new HarnessError('Unable to inspect a command stdin file.', { cause: error });
  }
}

async function safeRealpath(path: string, subject: 'file' | 'root'): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new HarnessError(`Unable to resolve a command stdin ${subject}.`, { cause: error });
  }
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}
