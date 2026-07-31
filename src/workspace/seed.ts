import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { FixtureError } from '../domain/errors.js';

export interface SeedLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface SeedDirectory {
  readonly path: string;
  readonly type: 'directory';
}

export interface SeedFile {
  readonly contentBase64: string;
  readonly executable: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: 'file';
}

export type SeedEntry = SeedDirectory | SeedFile;

export interface SeedSnapshot {
  readonly digest: string;
  readonly entries: readonly SeedEntry[];
  readonly totalBytes: number;
}

interface MutableLoadState {
  entries: SeedEntry[];
  totalBytes: number;
}

export async function loadSeed(root: string, limits: SeedLimits): Promise<SeedSnapshot> {
  validateLimits(limits);
  const lexicalRoot = resolve(root);
  const rootMetadata = await safeLstat(lexicalRoot, 'seed root');
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new FixtureError('The seed root must be a regular directory.');
  }
  const canonicalRoot = await safeRealpath(lexicalRoot, 'seed root');
  if (!samePath(lexicalRoot, canonicalRoot)) {
    throw new FixtureError('The seed root resolves through a link or reparse point.');
  }

  const state: MutableLoadState = {
    entries: [],
    totalBytes: 0,
  };
  await walkDirectory(canonicalRoot, canonicalRoot, '', 0, limits, state);

  const entries = Object.freeze(state.entries.map((entry) => Object.freeze(entry)));
  return Object.freeze({
    digest: digestEntries(entries),
    entries,
    totalBytes: state.totalBytes,
  });
}

async function walkDirectory(
  canonicalRoot: string,
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  limits: SeedLimits,
  state: MutableLoadState,
): Promise<void> {
  if (depth > limits.maxDepth) {
    throw new FixtureError('The seed exceeds its maximum directory depth.');
  }
  const before = await safeLstat(absoluteDirectory, 'seed directory');
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new FixtureError('A seed directory changed type while it was read.');
  }
  await assertCanonicalEntry(canonicalRoot, absoluteDirectory);

  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    throw new FixtureError('Unable to enumerate a seed directory.', { cause: error });
  }
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')),
  );

  for (const entry of entries) {
    validatePortableName(entry.name);
    const portablePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolutePath = resolve(absoluteDirectory, entry.name);
    if (!isContained(canonicalRoot, absolutePath)) {
      throw new FixtureError('A seed entry resolves outside the seed root.');
    }

    const metadata = await safeLstat(absolutePath, 'seed entry');
    if (metadata.isSymbolicLink()) {
      throw new FixtureError('Seed links, junctions, and reparse points are not supported.');
    }
    if (metadata.isDirectory()) {
      addEntry(state, { path: portablePath, type: 'directory' }, limits);
      await walkDirectory(canonicalRoot, absolutePath, portablePath, depth + 1, limits, state);
      continue;
    }
    if (!metadata.isFile()) {
      throw new FixtureError('The seed contains a non-file, non-directory entry.');
    }

    const file = await readStableFile(canonicalRoot, absolutePath, portablePath, limits);
    if (state.totalBytes + file.size > limits.maxTotalBytes) {
      throw new FixtureError('The seed exceeds its total byte limit.');
    }
    state.totalBytes += file.size;
    addEntry(state, file, limits);
  }

  const after = await safeLstat(absoluteDirectory, 'seed directory');
  if (!sameIdentity(before, after) || before.mtimeNs !== after.mtimeNs) {
    throw new FixtureError('A seed directory changed while it was read.');
  }
}

async function readStableFile(
  canonicalRoot: string,
  absolutePath: string,
  portablePath: string,
  limits: SeedLimits,
): Promise<SeedFile> {
  const before = await safeLstat(absolutePath, 'seed file');
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new FixtureError('A seed file changed type while it was read.');
  }
  await assertCanonicalEntry(canonicalRoot, absolutePath);
  if (before.size > BigInt(limits.maxFileBytes)) {
    throw new FixtureError('A seed file exceeds its byte limit.');
  }
  const expectedBytes = Number(before.size);
  const buffer = Buffer.alloc(expectedBytes + 1);

  let handle;
  try {
    handle = await open(absolutePath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      throw new FixtureError('A seed file changed before it could be read.');
    }

    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
      if (offset > expectedBytes || offset === buffer.length) {
        throw new FixtureError('A seed file grew while it was read.');
      }
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await safeLstat(absolutePath, 'seed file');
    if (
      offset !== expectedBytes ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(before, pathAfter)
    ) {
      throw new FixtureError('A seed file changed while it was read.');
    }
  } catch (error) {
    if (error instanceof FixtureError) {
      throw error;
    }
    throw new FixtureError('Unable to read a seed file.', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const content = buffer.subarray(0, expectedBytes);
  return {
    contentBase64: content.toString('base64'),
    executable: (before.mode & 0o111n) !== 0n,
    path: portablePath,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: expectedBytes,
    type: 'file',
  };
}

function addEntry(state: MutableLoadState, entry: SeedEntry, limits: SeedLimits): void {
  if (state.entries.length >= limits.maxEntries) {
    throw new FixtureError('The seed exceeds its entry limit.');
  }
  state.entries.push(entry);
}

async function assertCanonicalEntry(canonicalRoot: string, path: string): Promise<void> {
  const canonical = await safeRealpath(path, 'seed entry');
  if (!isContained(canonicalRoot, canonical) || !samePath(resolve(path), canonical)) {
    throw new FixtureError('A seed entry resolves through a link or outside the seed root.');
  }
}

function validatePortableName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new FixtureError('The seed contains a non-portable entry name.');
  }
}

function validateLimits(limits: SeedLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FixtureError(`${name} must be a non-negative safe integer.`);
    }
  }
  if (limits.maxEntries === 0) {
    throw new FixtureError('maxEntries must allow at least one seed entry.');
  }
}

function digestEntries(entries: readonly SeedEntry[]): string {
  const digest = createHash('sha256');
  digest.update('ghostcase/seed/v1\0', 'utf8');
  for (const entry of entries) {
    digest.update(entry.type === 'directory' ? Buffer.from([0]) : Buffer.from([1]));
    updateLengthPrefixed(digest, Buffer.from(entry.path, 'utf8'));
    if (entry.type === 'file') {
      digest.update(entry.executable ? Buffer.from([1]) : Buffer.from([0]));
      const content = Buffer.from(entry.contentBase64, 'base64');
      updateLengthPrefixed(digest, content);
    }
  }
  return digest.digest('hex');
}

function updateLengthPrefixed(digest: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  digest.update(length);
  digest.update(value);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function safeLstat(path: string, subject: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new FixtureError(`Unable to inspect the ${subject}.`, { cause: error });
  }
}

async function safeRealpath(path: string, subject: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new FixtureError(`Unable to resolve the ${subject}.`, { cause: error });
  }
}
