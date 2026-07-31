import type { FilesystemSnapshot, FilesystemSnapshotEntry } from './filesystem.js';

export type FilesystemChangeKind = 'added' | 'modified' | 'removed' | 'type_changed';

export interface FilesystemChange {
  readonly alias: string;
  readonly digest?: string;
  readonly kind: FilesystemChangeKind;
  readonly size?: number;
  readonly subjectId: string;
}

export interface FilesystemDiffCounts {
  readonly added: number;
  readonly modified: number;
  readonly removed: number;
  readonly total: number;
  readonly typeChanged: number;
}

export interface CompleteFilesystemDiff {
  readonly changes: readonly FilesystemChange[];
  readonly counts: FilesystemDiffCounts;
  readonly status: 'complete';
}

export type IncompatibleFilesystemSnapshotReason =
  'OBSERVER_VERSION_MISMATCH' | 'SPECIFICATION_MISMATCH';

export interface FilesystemDiffFailure {
  readonly error: {
    readonly code: 'INCOMPATIBLE_SNAPSHOTS';
    readonly reason: IncompatibleFilesystemSnapshotReason;
  };
  readonly status: 'failed';
}

export type FilesystemDiffResult = CompleteFilesystemDiff | FilesystemDiffFailure;

export function diffFilesystemSnapshots(
  before: FilesystemSnapshot,
  after: FilesystemSnapshot,
): FilesystemDiffResult {
  if (before.observerVersion !== after.observerVersion) {
    return failedDiff('OBSERVER_VERSION_MISMATCH');
  }
  if (before.specDigest !== after.specDigest) {
    return failedDiff('SPECIFICATION_MISMATCH');
  }

  const beforeEntries = indexEntries(before.entries);
  const afterEntries = indexEntries(after.entries);
  const keys = new Set([...beforeEntries.keys(), ...afterEntries.keys()]);
  const changes: FilesystemChange[] = [];
  const mutableCounts = {
    added: 0,
    modified: 0,
    removed: 0,
    typeChanged: 0,
  };

  for (const key of keys) {
    const beforeEntry = beforeEntries.get(key);
    const afterEntry = afterEntries.get(key);
    if (beforeEntry === undefined && afterEntry !== undefined) {
      changes.push(change(afterEntry, 'added'));
      mutableCounts.added += 1;
      continue;
    }
    if (beforeEntry !== undefined && afterEntry === undefined) {
      changes.push(change(beforeEntry, 'removed'));
      mutableCounts.removed += 1;
      continue;
    }
    if (beforeEntry === undefined || afterEntry === undefined) {
      continue;
    }
    if (beforeEntry.kind !== afterEntry.kind) {
      changes.push(change(afterEntry, 'type_changed'));
      mutableCounts.typeChanged += 1;
      continue;
    }
    if (
      beforeEntry.kind === 'file' &&
      afterEntry.kind === 'file' &&
      (beforeEntry.size !== afterEntry.size ||
        beforeEntry.contentDigest !== afterEntry.contentDigest)
    ) {
      changes.push(change(afterEntry, 'modified'));
      mutableCounts.modified += 1;
    }
  }

  changes.sort((left, right) => {
    const aliasOrder = compareUtf8(left.alias, right.alias);
    if (aliasOrder !== 0) {
      return aliasOrder;
    }
    const subjectOrder = left.subjectId.localeCompare(right.subjectId);
    return subjectOrder === 0 ? left.kind.localeCompare(right.kind) : subjectOrder;
  });
  const counts = Object.freeze({
    ...mutableCounts,
    total:
      mutableCounts.added +
      mutableCounts.modified +
      mutableCounts.removed +
      mutableCounts.typeChanged,
  });

  return Object.freeze({
    changes: Object.freeze(changes.map((item) => Object.freeze(item))),
    counts,
    status: 'complete',
  });
}

function indexEntries(
  entries: readonly FilesystemSnapshotEntry[],
): ReadonlyMap<string, FilesystemSnapshotEntry> {
  return new Map(entries.map((entry) => [`${entry.alias}\0${entry.relativePath}`, entry]));
}

function change(entry: FilesystemSnapshotEntry, kind: FilesystemChangeKind): FilesystemChange {
  return {
    alias: entry.alias,
    ...(entry.kind === 'file' ? { digest: entry.contentDigest, size: entry.size } : {}),
    kind,
    subjectId: entry.subjectId,
  };
}

function failedDiff(reason: IncompatibleFilesystemSnapshotReason): FilesystemDiffFailure {
  return Object.freeze({
    error: Object.freeze({
      code: 'INCOMPATIBLE_SNAPSHOTS',
      reason,
    }),
    status: 'failed',
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
