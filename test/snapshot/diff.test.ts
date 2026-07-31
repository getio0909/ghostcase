import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { diffFilesystemSnapshots } from '../../src/snapshot/diff.js';
import {
  captureFilesystemSnapshot,
  type FilesystemSnapshot,
  type FilesystemSnapshotLimits,
} from '../../src/snapshot/filesystem.js';

const limits: FilesystemSnapshotLimits = {
  maxDepth: 8,
  maxEntries: 100,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
};

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe('diffFilesystemSnapshots', () => {
  it('reports a stable, path-redacted change taxonomy and counts', async () => {
    const workspace = await createWorkspace();
    const state = join(workspace, 'state');
    await mkdir(state);
    await writeFile(join(state, 'private-modified.txt'), 'before');
    await writeFile(join(state, 'private-removed.txt'), 'remove');
    await writeFile(join(state, 'private-shape'), 'file');
    const before = await captureComplete(workspace);

    await writeFile(join(state, 'private-modified.txt'), 'after');
    await unlink(join(state, 'private-removed.txt'));
    await unlink(join(state, 'private-shape'));
    await mkdir(join(state, 'private-shape'));
    await writeFile(join(state, 'private-added.txt'), 'add');
    const after = await captureComplete(workspace);

    const result = diffFilesystemSnapshots(before, after);

    expect(result).toMatchObject({
      counts: {
        added: 1,
        modified: 1,
        removed: 1,
        total: 4,
        typeChanged: 1,
      },
      status: 'complete',
    });
    if (result.status !== 'complete') {
      throw new Error('Expected a complete diff');
    }
    expect(result.changes.map((change) => change.kind).sort()).toEqual([
      'added',
      'modified',
      'removed',
      'type_changed',
    ]);
    expect(result.changes.every((change) => change.alias === 'state')).toBe(true);
    expect(result.changes.every((change) => /^[a-f\d]{64}$/u.test(change.subjectId))).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-');
    expect(serialized).not.toContain('relativePath');
    expect(serialized).not.toContain('contentDigest');
    for (const entry of [...before.entries, ...after.entries]) {
      if (entry.kind === 'file') {
        expect(serialized).not.toContain(entry.contentDigest);
      }
    }
  });

  it('does not report unchanged directories or equal file contents', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state', 'empty'), { recursive: true });
    await writeFile(join(workspace, 'state', 'same.txt'), 'same');
    const before = await captureComplete(workspace);
    const after = await captureComplete(workspace);

    const result = diffFilesystemSnapshots(before, after);

    expect(result).toEqual({
      changes: [],
      counts: {
        added: 0,
        modified: 0,
        removed: 0,
        total: 0,
        typeChanged: 0,
      },
      status: 'complete',
    });
  });

  it('fails closed when snapshots used different observer specifications', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    const before = await captureComplete(workspace);
    const changedLimits = await captureFilesystemSnapshot({
      limits: { ...limits, maxEntries: limits.maxEntries + 1 },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });
    if (changedLimits.status !== 'complete') {
      throw new Error('Expected a complete snapshot with changed limits');
    }

    const result = diffFilesystemSnapshots(before, changedLimits);

    expect(result).toEqual({
      error: {
        code: 'INCOMPATIBLE_SNAPSHOTS',
        reason: 'SPECIFICATION_MISMATCH',
      },
      status: 'failed',
    });
  });

  it('fails closed when snapshots use different observer versions', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    const before = await captureComplete(workspace);

    const result = diffFilesystemSnapshots(before, {
      ...before,
      observerVersion: 'filesystem-v2',
    });

    expect(result).toEqual({
      error: {
        code: 'INCOMPATIBLE_SNAPSHOTS',
        reason: 'OBSERVER_VERSION_MISMATCH',
      },
      status: 'failed',
    });
  });
});

async function createWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ghostcase-diff-'));
  temporaryPaths.push(path);
  return path;
}

async function captureComplete(workspaceRoot: string): Promise<FilesystemSnapshot> {
  const result = await captureFilesystemSnapshot({
    limits,
    roots: [{ alias: 'state', path: 'state' }],
    workspaceRoot,
  });

  if (result.status !== 'complete') {
    throw new Error(`Expected a complete snapshot, received ${result.error.code}`);
  }
  return result;
}
