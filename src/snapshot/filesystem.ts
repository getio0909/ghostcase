import { createHash, type Hash } from 'node:crypto';
import { constants as filesystemConstants, type BigIntStats, type PathLike } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep, win32 } from 'node:path';

const FILESYSTEM_OBSERVER_VERSION = 'filesystem-v1';
const MAX_ROOTS = 64;
const READ_BUFFER_BYTES = 64 * 1024;
const WINDOWS_ILLEGAL_NAME_CHARACTER = /[<>:"/\\|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export interface FilesystemObserverRoot {
  readonly alias: string;
  readonly path: string;
}

export interface FilesystemSnapshotLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface CaptureFilesystemSnapshotOptions {
  readonly limits: FilesystemSnapshotLimits;
  readonly roots: readonly FilesystemObserverRoot[];
  readonly workspaceRoot: string;
}

interface FilesystemEntryBase {
  readonly alias: string;
  readonly relativePath: string;
  readonly subjectId: string;
}

export interface FilesystemDirectoryEntry extends FilesystemEntryBase {
  readonly kind: 'directory';
}

export interface FilesystemFileEntry extends FilesystemEntryBase {
  readonly contentDigest: string;
  readonly kind: 'file';
  readonly size: number;
}

export type FilesystemSnapshotEntry = FilesystemDirectoryEntry | FilesystemFileEntry;

export interface FilesystemSnapshotCounts {
  readonly directories: number;
  readonly entries: number;
  readonly files: number;
  readonly totalBytes: number;
}

export interface FilesystemSnapshot {
  readonly aggregateDigest: string;
  readonly counts: FilesystemSnapshotCounts;
  readonly entries: readonly FilesystemSnapshotEntry[];
  readonly observerVersion: string;
  readonly specDigest: string;
  readonly status: 'complete';
}

export type InvalidFilesystemConfigReason =
  | 'DUPLICATE_ALIAS'
  | 'EMPTY_ROOTS'
  | 'INVALID_ALIAS'
  | 'INVALID_LIMIT'
  | 'INVALID_ROOT_PATH'
  | 'INVALID_WORKSPACE_ROOT'
  | 'OVERLAPPING_ROOTS'
  | 'TOO_MANY_ROOTS';

export interface InvalidFilesystemConfigError {
  readonly code: 'INVALID_CONFIG';
  readonly field: string;
  readonly reason: InvalidFilesystemConfigReason;
}

export type UnsafeFilesystemPathReason =
  'NON_PORTABLE_NAME' | 'OUTSIDE_WORKSPACE' | 'SYMLINK_OR_REPARSE_POINT';

export interface UnsafeFilesystemPathError {
  readonly alias: string;
  readonly code: 'UNSAFE_PATH';
  readonly reason: UnsafeFilesystemPathReason;
  readonly subjectId: string;
}

export interface UnsupportedFilesystemTypeError {
  readonly alias: string;
  readonly code: 'UNSUPPORTED_FILE_TYPE';
  readonly subjectId: string;
}

export type FilesystemLimitName = 'maxDepth' | 'maxEntries' | 'maxFileBytes' | 'maxTotalBytes';

export interface FilesystemLimitExceededError {
  readonly alias: string;
  readonly code: 'LIMIT_EXCEEDED';
  readonly limit: FilesystemLimitName;
  readonly maximum: number;
  readonly observed: string;
  readonly subjectId: string;
}

export type FilesystemOperation =
  | 'capture'
  | 'close_file'
  | 'inspect_path'
  | 'open_file'
  | 'read_directory'
  | 'read_file'
  | 'resolve_path';

export interface UnstableFilesystemStateError {
  readonly alias: string;
  readonly code: 'UNSTABLE_STATE';
  readonly operation: 'read_directory' | 'read_file';
  readonly subjectId: string;
}

export interface FilesystemIoError {
  readonly code: 'IO_ERROR';
  readonly operation: FilesystemOperation;
  readonly subjectId: string;
  readonly systemCode: string;
}

export type FilesystemSnapshotError =
  | InvalidFilesystemConfigError
  | UnsafeFilesystemPathError
  | UnsupportedFilesystemTypeError
  | FilesystemLimitExceededError
  | UnstableFilesystemStateError
  | FilesystemIoError;

export interface FilesystemSnapshotFailure {
  readonly error: FilesystemSnapshotError;
  readonly status: 'failed';
}

export type FilesystemSnapshotResult = FilesystemSnapshot | FilesystemSnapshotFailure;

interface ValidatedRoot {
  readonly alias: string;
  readonly path: string;
  readonly segments: readonly string[];
}

interface ValidatedPlan {
  readonly limits: FilesystemSnapshotLimits;
  readonly roots: readonly ValidatedRoot[];
  readonly specDigest: string;
  readonly workspaceRoot: string;
}

interface CaptureContext {
  directories: number;
  discoveredEntries: number;
  readonly entryKeys: Set<string>;
  entries: FilesystemSnapshotEntry[];
  files: number;
  readonly limits: FilesystemSnapshotLimits;
  readonly revalidations: RevalidationEntry[];
  totalBytes: number;
  readonly workspaceCanonical: string;
  readonly workspaceLexical: string;
}

interface EntryLocation {
  readonly absolutePath: string;
  readonly alias: string;
  readonly depth: number;
  readonly expectedCanonicalPath: string;
  readonly relativePath: string;
  readonly reserved: boolean;
  readonly subjectId: string;
}

interface RevalidationEntry {
  readonly identity: BigIntStats;
  readonly kind: 'directory' | 'file';
  readonly location: EntryLocation;
}

class SnapshotAbort extends Error {
  readonly snapshotError: FilesystemSnapshotError;

  constructor(snapshotError: FilesystemSnapshotError) {
    super(snapshotError.code);
    this.name = 'SnapshotAbort';
    this.snapshotError = snapshotError;
  }
}

export async function captureFilesystemSnapshot(
  options: CaptureFilesystemSnapshotOptions,
): Promise<FilesystemSnapshotResult> {
  const validated = validateOptions(options);
  if ('error' in validated) {
    return validated;
  }

  try {
    const workspaceStats = await inspectPath(validated.workspaceRoot, 'workspace');
    if (!workspaceStats.isDirectory()) {
      return failure({
        code: 'INVALID_CONFIG',
        field: 'workspaceRoot',
        reason: 'INVALID_WORKSPACE_ROOT',
      });
    }
    if (workspaceStats.isSymbolicLink()) {
      return failure({
        alias: 'workspace',
        code: 'UNSAFE_PATH',
        reason: 'SYMLINK_OR_REPARSE_POINT',
        subjectId: hashSubject('workspace', '.'),
      });
    }

    const workspaceCanonical = await resolvePath(validated.workspaceRoot, 'workspace');
    const context: CaptureContext = {
      directories: 0,
      discoveredEntries: 0,
      entryKeys: new Set(),
      entries: [],
      files: 0,
      limits: validated.limits,
      revalidations: [],
      totalBytes: 0,
      workspaceCanonical,
      workspaceLexical: validated.workspaceRoot,
    };

    for (const root of validated.roots) {
      const absolutePath = join(context.workspaceLexical, ...root.segments);
      const expectedCanonicalPath = join(context.workspaceCanonical, ...root.segments);
      await captureEntry(context, {
        absolutePath,
        alias: root.alias,
        depth: 0,
        expectedCanonicalPath,
        relativePath: '.',
        reserved: false,
        subjectId: hashSubject(root.alias, '.'),
      });
    }

    await revalidateCapturedEntries(context);
    context.entries.sort(compareEntries);
    const entries = Object.freeze(context.entries.map(freezeEntry));
    const counts = Object.freeze({
      directories: context.directories,
      entries: entries.length,
      files: context.files,
      totalBytes: context.totalBytes,
    });

    return Object.freeze({
      aggregateDigest: aggregateDigest(validated.specDigest, entries),
      counts,
      entries,
      observerVersion: FILESYSTEM_OBSERVER_VERSION,
      specDigest: validated.specDigest,
      status: 'complete',
    });
  } catch (error) {
    if (error instanceof SnapshotAbort) {
      return failure(error.snapshotError);
    }
    return failure(ioError('capture', 'capture', error));
  }
}

function validateOptions(options: unknown): ValidatedPlan | FilesystemSnapshotFailure {
  if (!isRecord(options)) {
    return invalidConfig('options', 'INVALID_WORKSPACE_ROOT');
  }
  if (
    typeof options.workspaceRoot !== 'string' ||
    options.workspaceRoot.length === 0 ||
    options.workspaceRoot.includes('\0') ||
    !isAbsolute(options.workspaceRoot)
  ) {
    return invalidConfig('workspaceRoot', 'INVALID_WORKSPACE_ROOT');
  }

  const limits = validateLimits(options.limits);
  if ('error' in limits) {
    return limits;
  }
  if (!Array.isArray(options.roots) || options.roots.length === 0) {
    return invalidConfig('roots', 'EMPTY_ROOTS');
  }
  if (options.roots.length > MAX_ROOTS) {
    return invalidConfig('roots', 'TOO_MANY_ROOTS');
  }

  const aliases = new Set<string>();
  const roots: ValidatedRoot[] = [];
  const rootCandidates: readonly unknown[] = options.roots;
  for (const [index, root] of rootCandidates.entries()) {
    if (!isRecord(root)) {
      return invalidConfig(`roots[${index.toString()}]`, 'INVALID_ROOT_PATH');
    }
    if (typeof root.alias !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(root.alias)) {
      return invalidConfig(`roots[${index.toString()}].alias`, 'INVALID_ALIAS');
    }
    if (aliases.has(root.alias)) {
      return invalidConfig('roots', 'DUPLICATE_ALIAS');
    }
    aliases.add(root.alias);

    const rootPath = root.path;
    if (typeof rootPath !== 'string') {
      return invalidConfig('roots', 'INVALID_ROOT_PATH');
    }
    const segments = validatePortableRelativePath(rootPath);
    if (segments === undefined) {
      return invalidConfig('roots', 'INVALID_ROOT_PATH');
    }
    roots.push({
      alias: root.alias,
      path: rootPath,
      segments,
    });
  }

  for (const [leftIndex, left] of roots.entries()) {
    for (const right of roots.slice(leftIndex + 1)) {
      if (
        isSegmentPrefix(left.segments, right.segments) ||
        isSegmentPrefix(right.segments, left.segments)
      ) {
        return invalidConfig('roots', 'OVERLAPPING_ROOTS');
      }
    }
  }

  roots.sort((left, right) => {
    const aliasOrder = compareUtf8(left.alias, right.alias);
    return aliasOrder === 0 ? compareUtf8(left.path, right.path) : aliasOrder;
  });
  const normalizedLimits = Object.freeze({ ...limits });
  const normalizedRoots = Object.freeze(
    roots.map((root) =>
      Object.freeze({
        ...root,
        segments: Object.freeze([...root.segments]),
      }),
    ),
  );

  return {
    limits: normalizedLimits,
    roots: normalizedRoots,
    specDigest: computeSpecDigest(normalizedRoots, normalizedLimits),
    workspaceRoot: resolve(options.workspaceRoot),
  };
}

function validateLimits(limits: unknown): FilesystemSnapshotLimits | FilesystemSnapshotFailure {
  if (!isRecord(limits)) {
    return invalidConfig('limits', 'INVALID_LIMIT');
  }
  if (!isNonNegativeSafeInteger(limits.maxDepth)) {
    return invalidConfig('limits.maxDepth', 'INVALID_LIMIT');
  }
  if (!isPositiveSafeInteger(limits.maxEntries)) {
    return invalidConfig('limits.maxEntries', 'INVALID_LIMIT');
  }
  if (!isNonNegativeSafeInteger(limits.maxFileBytes)) {
    return invalidConfig('limits.maxFileBytes', 'INVALID_LIMIT');
  }
  if (!isNonNegativeSafeInteger(limits.maxTotalBytes)) {
    return invalidConfig('limits.maxTotalBytes', 'INVALID_LIMIT');
  }
  return {
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
  };
}

function validatePortableRelativePath(candidate: unknown): readonly string[] | undefined {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    candidate.includes(':') ||
    candidate.startsWith('/') ||
    candidate.endsWith('/') ||
    win32.isAbsolute(candidate)
  ) {
    return undefined;
  }
  if (candidate === '.') {
    return [];
  }

  const segments = candidate.split('/');
  if (
    segments.some((segment) => !isPortableSegment(segment) || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return segments;
}

function isPortableSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !containsControlCharacter(segment) &&
    !segment.includes('\uFFFD') &&
    !WINDOWS_ILLEGAL_NAME_CHARACTER.test(segment) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !WINDOWS_RESERVED_NAME.test(segment)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x1f) {
      return true;
    }
  }
  return false;
}

function isSegmentPrefix(possiblePrefix: readonly string[], candidate: readonly string[]): boolean {
  return (
    possiblePrefix.length <= candidate.length &&
    possiblePrefix.every((segment, index) => {
      const candidateSegment = candidate[index];
      return candidateSegment !== undefined && comparePathSegment(segment, candidateSegment) === 0;
    })
  );
}

function comparePathSegment(left: string, right: string): number {
  if (process.platform === 'win32') {
    return left.localeCompare(right, 'en', { sensitivity: 'accent' });
  }
  return left === right ? 0 : 1;
}

async function captureEntry(context: CaptureContext, location: EntryLocation): Promise<void> {
  enforceDepth(context, location);
  if (!location.reserved) {
    reserveEntry(context, location.alias, location.subjectId);
  }
  const before = await inspectPath(location.absolutePath, location.subjectId);
  if (before.isSymbolicLink()) {
    abort({
      alias: location.alias,
      code: 'UNSAFE_PATH',
      reason: 'SYMLINK_OR_REPARSE_POINT',
      subjectId: location.subjectId,
    });
  }
  await assertCanonicalLocation(location);

  if (before.isDirectory()) {
    await captureDirectory(context, location, before);
    return;
  }
  if (before.isFile()) {
    await captureFile(context, location, before);
    return;
  }
  abort({
    alias: location.alias,
    code: 'UNSUPPORTED_FILE_TYPE',
    subjectId: location.subjectId,
  });
}

async function captureDirectory(
  context: CaptureContext,
  location: EntryLocation,
  before: BigIntStats,
): Promise<void> {
  addEntry(context, location, {
    alias: location.alias,
    kind: 'directory',
    relativePath: location.relativePath,
    subjectId: location.subjectId,
  });
  context.directories += 1;

  const names = await readDirectory(context, location);
  names.sort(compareUtf8);
  for (const name of names) {
    const relativePath = location.relativePath === '.' ? name : `${location.relativePath}/${name}`;
    const subjectId = hashSubject(location.alias, relativePath);
    if (!isPortableSegment(name)) {
      abort({
        alias: location.alias,
        code: 'UNSAFE_PATH',
        reason: 'NON_PORTABLE_NAME',
        subjectId,
      });
    }
    await captureEntry(context, {
      absolutePath: join(location.absolutePath, name),
      alias: location.alias,
      depth: location.depth + 1,
      expectedCanonicalPath: join(location.expectedCanonicalPath, name),
      relativePath,
      reserved: true,
      subjectId,
    });
  }

  const after = await inspectPath(location.absolutePath, location.subjectId);
  if (!sameIdentity(before, after) || !after.isDirectory()) {
    abort({
      alias: location.alias,
      code: 'UNSTABLE_STATE',
      operation: 'read_directory',
      subjectId: location.subjectId,
    });
  }
  await assertCanonicalLocation(location);
  context.revalidations.push({
    identity: before,
    kind: 'directory',
    location,
  });
}

async function captureFile(
  context: CaptureContext,
  location: EntryLocation,
  before: BigIntStats,
): Promise<void> {
  enforceFileLimits(context, location, before.size);
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(location);
    const opened = await inspectHandle(handle, location);
    if (!sameIdentity(before, opened) || !opened.isFile()) {
      abort({
        alias: location.alias,
        code: 'UNSTABLE_STATE',
        operation: 'read_file',
        subjectId: location.subjectId,
      });
    }

    const size = Number(before.size);
    const contentDigest = await hashFile(handle, size, location);
    const afterHandle = await inspectHandle(handle, location);
    if (!sameIdentity(before, afterHandle) || !afterHandle.isFile()) {
      abort({
        alias: location.alias,
        code: 'UNSTABLE_STATE',
        operation: 'read_file',
        subjectId: location.subjectId,
      });
    }
    const afterPath = await inspectPath(location.absolutePath, location.subjectId);
    if (!sameIdentity(before, afterPath) || !afterPath.isFile()) {
      abort({
        alias: location.alias,
        code: 'UNSTABLE_STATE',
        operation: 'read_file',
        subjectId: location.subjectId,
      });
    }
    await assertCanonicalLocation(location);

    addEntry(context, location, {
      alias: location.alias,
      contentDigest,
      kind: 'file',
      relativePath: location.relativePath,
      size,
      subjectId: location.subjectId,
    });
    context.files += 1;
    context.totalBytes += size;
    context.revalidations.push({
      identity: before,
      kind: 'file',
      location,
    });
  } finally {
    if (handle !== undefined) {
      await closeFile(handle, location.subjectId);
    }
  }
}

function enforceDepth(context: CaptureContext, location: EntryLocation): void {
  if (location.depth > context.limits.maxDepth) {
    abort({
      alias: location.alias,
      code: 'LIMIT_EXCEEDED',
      limit: 'maxDepth',
      maximum: context.limits.maxDepth,
      observed: location.depth.toString(),
      subjectId: location.subjectId,
    });
  }
}

function enforceFileLimits(context: CaptureContext, location: EntryLocation, size: bigint): void {
  if (size > BigInt(context.limits.maxFileBytes)) {
    abort({
      alias: location.alias,
      code: 'LIMIT_EXCEEDED',
      limit: 'maxFileBytes',
      maximum: context.limits.maxFileBytes,
      observed: size.toString(),
      subjectId: location.subjectId,
    });
  }
  const nextTotal = BigInt(context.totalBytes) + size;
  if (nextTotal > BigInt(context.limits.maxTotalBytes)) {
    abort({
      alias: location.alias,
      code: 'LIMIT_EXCEEDED',
      limit: 'maxTotalBytes',
      maximum: context.limits.maxTotalBytes,
      observed: nextTotal.toString(),
      subjectId: location.subjectId,
    });
  }
}

function addEntry(
  context: CaptureContext,
  location: EntryLocation,
  entry: FilesystemSnapshotEntry,
): void {
  const key = entryKey(entry.alias, entry.relativePath);
  if (context.entryKeys.has(key)) {
    abort({
      alias: location.alias,
      code: 'UNSAFE_PATH',
      reason: 'NON_PORTABLE_NAME',
      subjectId: location.subjectId,
    });
  }
  context.entryKeys.add(key);
  context.entries.push(entry);
}

function reserveEntry(context: CaptureContext, alias: string, subjectId: string): void {
  const observed = context.discoveredEntries + 1;
  if (observed > context.limits.maxEntries) {
    abort({
      alias,
      code: 'LIMIT_EXCEEDED',
      limit: 'maxEntries',
      maximum: context.limits.maxEntries,
      observed: observed.toString(),
      subjectId,
    });
  }
  context.discoveredEntries = observed;
}

async function hashFile(
  handle: FileHandle,
  expectedSize: number,
  location: EntryLocation,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(expectedSize, 1)));
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.length, expectedSize - position);
    const { bytesRead } = await readFileChunk(handle, buffer, length, position, location);
    if (bytesRead === 0) {
      abort({
        alias: location.alias,
        code: 'UNSTABLE_STATE',
        operation: 'read_file',
        subjectId: location.subjectId,
      });
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  const growthProbe = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await readFileChunk(
    handle,
    growthProbe,
    1,
    expectedSize,
    location,
  );
  if (extraBytes !== 0) {
    abort({
      alias: location.alias,
      code: 'UNSTABLE_STATE',
      operation: 'read_file',
      subjectId: location.subjectId,
    });
  }
  return hash.digest('hex');
}

async function readFileChunk(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
  location: EntryLocation,
): Promise<{ readonly bytesRead: number }> {
  try {
    return await handle.read(buffer, 0, length, position);
  } catch (error) {
    throw new SnapshotAbort(ioError('read_file', location.subjectId, error));
  }
}

async function inspectHandle(handle: FileHandle, location: EntryLocation): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    throw new SnapshotAbort(ioError('inspect_path', location.subjectId, error));
  }
}

async function openFile(location: EntryLocation): Promise<FileHandle> {
  const noFollow = filesystemConstants.O_NOFOLLOW;
  const flags =
    process.platform !== 'win32' && typeof noFollow === 'number'
      ? filesystemConstants.O_RDONLY | noFollow
      : 'r';
  try {
    return await open(location.absolutePath, flags);
  } catch (error) {
    if (nodeErrorCode(error) === 'ELOOP') {
      abort({
        alias: location.alias,
        code: 'UNSAFE_PATH',
        reason: 'SYMLINK_OR_REPARSE_POINT',
        subjectId: location.subjectId,
      });
    }
    throw new SnapshotAbort(ioError('open_file', location.subjectId, error));
  }
}

async function closeFile(handle: FileHandle, subjectId: string): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    throw new SnapshotAbort(ioError('close_file', subjectId, error));
  }
}

async function inspectPath(path: PathLike, subjectId: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new SnapshotAbort(ioError('inspect_path', subjectId, error));
  }
}

async function resolvePath(path: PathLike, subjectId: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new SnapshotAbort(ioError('resolve_path', subjectId, error));
  }
}

async function readDirectory(context: CaptureContext, location: EntryLocation): Promise<string[]> {
  const remainingEntries = context.limits.maxEntries - context.discoveredEntries;
  let directory;
  try {
    directory = await opendir(location.absolutePath, {
      bufferSize: Math.min(32, Math.max(1, remainingEntries + 1)),
      encoding: 'utf8',
    });
  } catch (error) {
    throw new SnapshotAbort(ioError('read_directory', location.subjectId, error));
  }

  const names: string[] = [];
  const seenNames = new Set<string>();
  try {
    for await (const directoryEntry of directory) {
      const name = directoryEntry.name;
      const relativePath =
        location.relativePath === '.' ? name : `${location.relativePath}/${name}`;
      const subjectId = hashSubject(location.alias, relativePath);
      if (name.includes('\uFFFD') || seenNames.has(name)) {
        abort({
          alias: location.alias,
          code: 'UNSAFE_PATH',
          reason: 'NON_PORTABLE_NAME',
          subjectId,
        });
      }
      reserveEntry(context, location.alias, subjectId);
      seenNames.add(name);
      names.push(name);
    }
  } catch (error) {
    if (error instanceof SnapshotAbort) {
      throw error;
    }
    throw new SnapshotAbort(ioError('read_directory', location.subjectId, error));
  }
  return names;
}

async function assertCanonicalLocation(location: EntryLocation): Promise<void> {
  const actual = await resolvePath(location.absolutePath, location.subjectId);
  if (!pathsEqual(actual, location.expectedCanonicalPath)) {
    abort({
      alias: location.alias,
      code: 'UNSAFE_PATH',
      reason: 'SYMLINK_OR_REPARSE_POINT',
      subjectId: location.subjectId,
    });
  }
}

async function revalidateCapturedEntries(context: CaptureContext): Promise<void> {
  for (const entry of context.revalidations) {
    const current = await inspectPath(entry.location.absolutePath, entry.location.subjectId);
    const sameKind = entry.kind === 'file' ? current.isFile() : current.isDirectory();
    if (current.isSymbolicLink() || !sameKind || !sameIdentity(entry.identity, current)) {
      abort({
        alias: entry.location.alias,
        code: 'UNSTABLE_STATE',
        operation: entry.kind === 'file' ? 'read_file' : 'read_directory',
        subjectId: entry.location.subjectId,
      });
    }
    await assertCanonicalLocation(entry.location);
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return normalizedLeft === normalizedRight;
}

function normalizeComparablePath(value: string): string {
  let normalized = resolve(value);
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  if (process.platform === 'win32') {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
      .replace(/^\\\\\?\\/u, '')
      .toLocaleLowerCase('en-US');
  }
  return normalized;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function freezeEntry(entry: FilesystemSnapshotEntry): FilesystemSnapshotEntry {
  return Object.freeze({ ...entry });
}

function compareEntries(left: FilesystemSnapshotEntry, right: FilesystemSnapshotEntry): number {
  const aliasOrder = compareUtf8(left.alias, right.alias);
  return aliasOrder === 0 ? compareUtf8(left.relativePath, right.relativePath) : aliasOrder;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function computeSpecDigest(
  roots: readonly ValidatedRoot[],
  limits: FilesystemSnapshotLimits,
): string {
  const writer = new DigestWriter('ghostcase/filesystem-spec/v1');
  writer.writeString(FILESYSTEM_OBSERVER_VERSION);
  writer.writeNumber(limits.maxDepth);
  writer.writeNumber(limits.maxEntries);
  writer.writeNumber(limits.maxFileBytes);
  writer.writeNumber(limits.maxTotalBytes);
  writer.writeNumber(roots.length);
  for (const root of roots) {
    writer.writeString(root.alias);
    writer.writeString(root.path);
  }
  return writer.digest();
}

function aggregateDigest(specDigest: string, entries: readonly FilesystemSnapshotEntry[]): string {
  const writer = new DigestWriter('ghostcase/filesystem-snapshot/v1');
  writer.writeString(specDigest);
  writer.writeNumber(entries.length);
  for (const entry of entries) {
    writer.writeString(entry.alias);
    writer.writeString(entry.relativePath);
    writer.writeString(entry.kind);
    if (entry.kind === 'file') {
      writer.writeNumber(entry.size);
      writer.writeString(entry.contentDigest);
    }
  }
  return writer.digest();
}

function hashSubject(alias: string, relativePath: string): string {
  const writer = new DigestWriter('ghostcase/filesystem-subject/v1');
  writer.writeString(alias);
  writer.writeString(relativePath);
  return writer.digest();
}

function entryKey(alias: string, relativePath: string): string {
  return `${alias}\0${relativePath}`;
}

class DigestWriter {
  readonly #hash: Hash;

  constructor(domain: string) {
    this.#hash = createHash('sha256');
    this.writeString(domain);
  }

  writeNumber(value: number): void {
    this.writeString(value.toString(10));
  }

  writeString(value: string): void {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    this.#hash.update(length);
    this.#hash.update(bytes);
  }

  digest(): string {
    return this.#hash.digest('hex');
  }
}

function invalidConfig(
  field: string,
  reason: InvalidFilesystemConfigReason,
): FilesystemSnapshotFailure {
  return failure({ code: 'INVALID_CONFIG', field, reason });
}

function failure(error: FilesystemSnapshotError): FilesystemSnapshotFailure {
  return Object.freeze({
    error: Object.freeze(error),
    status: 'failed',
  });
}

function ioError(
  operation: FilesystemOperation,
  subjectId: string,
  error: unknown,
): FilesystemIoError {
  return {
    code: 'IO_ERROR',
    operation,
    subjectId,
    systemCode: nodeErrorCode(error),
  };
}

function nodeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'UNKNOWN';
}

function abort(error: FilesystemSnapshotError): never {
  throw new SnapshotAbort(error);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object';
}
