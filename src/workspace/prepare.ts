import { createHash, type Hash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { FixtureError } from '../domain/errors.js';
import type { LoadedManifest, ResolvedStateRoot } from '../domain/model.js';
import {
  loadSeed,
  type SeedEntry,
  type SeedFile,
  type SeedLimits,
  type SeedSnapshot,
} from './seed.js';

export const DEFAULT_SEED_LIMITS: Readonly<SeedLimits> = Object.freeze({
  maxDepth: 64,
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export interface PreparedStateRoot {
  readonly id: string;
  readonly kind: 'copy' | 'empty';
  readonly sourceDigest: string;
  readonly totalBytes: number;
}

export interface PreparedSuite {
  readonly snapshot: SeedSnapshot;
  readonly stateRoots: readonly PreparedStateRoot[];
}

type RootInput =
  | {
      readonly id: string;
      readonly kind: 'copy';
      readonly resolvedPath: string;
    }
  | {
      readonly id: string;
      readonly kind: 'empty';
    };

const rootIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const emptySourceDigest = createHash('sha256')
  .update('ghostcase/empty-seed/v1\0', 'utf8')
  .digest('hex');

export async function prepareSuite(
  manifest: LoadedManifest,
  requestedLimits: Readonly<SeedLimits> = DEFAULT_SEED_LIMITS,
): Promise<PreparedSuite> {
  const limits = effectiveLimits(manifest, requestedLimits);
  const roots = copyAndSortRoots(manifest.stateRoots);
  const entries: SeedEntry[] = [
    { path: 'state', type: 'directory' },
    ...roots.map(({ id }) => ({ path: `state/${id}`, type: 'directory' }) as const),
    { path: 'temp', type: 'directory' },
  ];
  if (entries.length > limits.maxEntries) {
    throw new FixtureError('The combined seed exceeds its entry limit.');
  }

  const paths = new Set<string>();
  for (const entry of entries) {
    addUniquePath(paths, entry.path);
  }

  const metadata: PreparedStateRoot[] = [];
  let totalBytes = 0;

  for (const root of roots) {
    if (root.kind === 'empty') {
      metadata.push({
        id: root.id,
        kind: root.kind,
        sourceDigest: emptySourceDigest,
        totalBytes: 0,
      });
      continue;
    }

    const remainingEntries = limits.maxEntries - entries.length;
    const remainingBytes = limits.maxTotalBytes - totalBytes;
    const source = await loadSeed(root.resolvedPath, {
      maxDepth: limits.maxDepth,
      maxEntries: Math.max(1, remainingEntries),
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: remainingBytes,
    });
    if (source.entries.length > remainingEntries) {
      throw new FixtureError('The combined seed exceeds its entry limit.');
    }
    if (source.totalBytes > remainingBytes) {
      throw new FixtureError('The combined seed exceeds its total byte limit.');
    }

    for (const sourceEntry of source.entries) {
      const prefixed = prefixEntry(root.id, sourceEntry);
      addUniquePath(paths, prefixed.path);
      entries.push(prefixed);
    }
    totalBytes += source.totalBytes;
    metadata.push({
      id: root.id,
      kind: root.kind,
      sourceDigest: source.digest,
      totalBytes: source.totalBytes,
    });
  }

  entries.sort(compareEntries);
  assertStrictlyOrdered(entries);
  const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  const frozenMetadata = Object.freeze(metadata.map((root) => Object.freeze(root)));
  const snapshot: SeedSnapshot = Object.freeze({
    digest: digestPreparedSeed(frozenEntries, frozenMetadata, totalBytes),
    entries: frozenEntries,
    totalBytes,
  });
  return Object.freeze({
    snapshot,
    stateRoots: frozenMetadata,
  });
}

function effectiveLimits(manifest: LoadedManifest, requested: Readonly<SeedLimits>): SeedLimits {
  const copied = copyLimits(requested);
  const execution = manifest.definition.execution;
  const maxSnapshotEntries = positiveSafeInteger(
    execution.maxSnapshotEntries,
    'manifest maxSnapshotEntries',
  );
  const maxSnapshotFileBytes = positiveSafeInteger(
    execution.maxSnapshotFileBytes,
    'manifest maxSnapshotFileBytes',
  );
  const maxSnapshotBytes = positiveSafeInteger(
    execution.maxSnapshotBytes,
    'manifest maxSnapshotBytes',
  );
  return {
    maxDepth: copied.maxDepth,
    maxEntries: Math.min(copied.maxEntries, maxSnapshotEntries),
    maxFileBytes: Math.min(copied.maxFileBytes, maxSnapshotFileBytes),
    maxTotalBytes: Math.min(copied.maxTotalBytes, maxSnapshotBytes),
  };
}

function copyLimits(limits: Readonly<SeedLimits>): SeedLimits {
  const copied: SeedLimits = {
    maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
  };
  for (const [name, value] of Object.entries(copied)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FixtureError(`${name} must be a non-negative safe integer.`);
    }
  }
  if (copied.maxEntries === 0) {
    throw new FixtureError('maxEntries must allow at least one seed entry.');
  }
  return copied;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FixtureError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function copyAndSortRoots(stateRoots: readonly ResolvedStateRoot[]): RootInput[] {
  if (stateRoots.length === 0) {
    throw new FixtureError('The loaded manifest must contain at least one state root.');
  }
  const seen = new Set<string>();
  const roots = stateRoots.map((root): RootInput => {
    if (!rootIdPattern.test(root.id)) {
      throw new FixtureError('The loaded manifest contains an invalid state root id.');
    }
    if (seen.has(root.id)) {
      throw new FixtureError('The loaded manifest contains a duplicate state root path.');
    }
    seen.add(root.id);
    if (root.seed.kind === 'empty') {
      return { id: root.id, kind: root.seed.kind };
    }
    if (!isAbsolute(root.seed.resolvedPath)) {
      throw new FixtureError('A resolved copy seed path must be absolute.');
    }
    return {
      id: root.id,
      kind: root.seed.kind,
      resolvedPath: root.seed.resolvedPath,
    };
  });
  roots.sort((left, right) => comparePortableText(left.id, right.id));
  return roots;
}

function prefixEntry(rootId: string, entry: SeedEntry): SeedEntry {
  const path = `state/${rootId}/${entry.path}`;
  return entry.type === 'directory'
    ? {
        path,
        type: entry.type,
      }
    : {
        contentBase64: entry.contentBase64,
        executable: entry.executable,
        path,
        sha256: entry.sha256,
        size: entry.size,
        type: entry.type,
      };
}

function addUniquePath(paths: Set<string>, path: string): void {
  const portableKey = path.toLowerCase();
  if (paths.has(portableKey)) {
    throw new FixtureError('The combined seed contains a duplicate path.');
  }
  paths.add(portableKey);
}

function compareEntries(left: SeedEntry, right: SeedEntry): number {
  return comparePortableText(left.path, right.path);
}

function comparePortableText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertStrictlyOrdered(entries: readonly SeedEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined || compareEntries(previous, current) >= 0) {
      throw new FixtureError('The combined seed entries do not have a deterministic order.');
    }
  }
}

function digestPreparedSeed(
  entries: readonly SeedEntry[],
  roots: readonly PreparedStateRoot[],
  totalBytes: number,
): string {
  const digest = createHash('sha256');
  digest.update('ghostcase/prepared-seed/v1\0', 'utf8');
  updateInteger(digest, roots.length);
  for (const root of roots) {
    updateText(digest, root.id);
    updateText(digest, root.kind);
    updateText(digest, root.sourceDigest);
    updateInteger(digest, root.totalBytes);
  }
  updateInteger(digest, entries.length);
  for (const entry of entries) {
    digest.update(entry.type === 'directory' ? Buffer.from([0]) : Buffer.from([1]));
    updateText(digest, entry.path);
    if (entry.type === 'file') {
      digestFile(digest, entry);
    }
  }
  updateInteger(digest, totalBytes);
  return digest.digest('hex');
}

function digestFile(digest: Hash, file: SeedFile): void {
  digest.update(file.executable ? Buffer.from([1]) : Buffer.from([0]));
  updateInteger(digest, file.size);
  updateText(digest, file.sha256);
  updateBytes(digest, Buffer.from(file.contentBase64, 'base64'));
}

function updateText(digest: Hash, value: string): void {
  updateBytes(digest, Buffer.from(value, 'utf8'));
}

function updateBytes(digest: Hash, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  digest.update(length);
  digest.update(value);
}

function updateInteger(digest: Hash, value: number): void {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  digest.update(encoded);
}
