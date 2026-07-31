import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureFilesystemSnapshot,
  type FilesystemSnapshot,
  type FilesystemSnapshotLimits,
} from '../../src/snapshot/filesystem.js';

const generousLimits: FilesystemSnapshotLimits = {
  maxDepth: 16,
  maxEntries: 100,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
};

const temporaryPaths: string[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe('captureFilesystemSnapshot', () => {
  it('captures files and empty directories with stable aggregate evidence', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state', 'empty'), { recursive: true });
    await writeFile(join(workspace, 'state', 'b.txt'), 'bravo');
    await writeFile(join(workspace, 'state', 'a.txt'), 'alpha');

    const first = await captureComplete(workspace);

    await unlink(join(workspace, 'state', 'a.txt'));
    await unlink(join(workspace, 'state', 'b.txt'));
    await writeFile(join(workspace, 'state', 'a.txt'), 'alpha');
    await writeFile(join(workspace, 'state', 'b.txt'), 'bravo');
    await utimes(
      join(workspace, 'state', 'a.txt'),
      new Date('2040-01-01T00:00:00.000Z'),
      new Date('2040-01-01T00:00:00.000Z'),
    );

    const second = await captureComplete(workspace);

    expect(first.aggregateDigest).toBe(second.aggregateDigest);
    expect(first.counts).toEqual({
      directories: 2,
      entries: 4,
      files: 2,
      totalBytes: 10,
    });
    expect(first.entries.map((entry) => entry.relativePath)).toEqual([
      '.',
      'a.txt',
      'b.txt',
      'empty',
    ]);
  });

  it('preserves a leading byte-order-mark character in a filename', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    await writeFile(join(workspace, 'state', 'a'), 'plain');
    await writeFile(join(workspace, 'state', '\uFEFFa'), 'bom');

    const snapshot = await captureComplete(workspace);

    expect(snapshot.entries.map((entry) => entry.relativePath)).toEqual(['.', 'a', '\uFEFFa']);
    expect(snapshot.counts.files).toBe(2);
  });

  it('allows limits exactly and fails the whole source when exceeded by one', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    await writeFile(join(workspace, 'state', 'exact.bin'), Buffer.alloc(4, 1));

    const exact = await captureFilesystemSnapshot({
      limits: {
        maxDepth: 1,
        maxEntries: 2,
        maxFileBytes: 4,
        maxTotalBytes: 4,
      },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });
    const tooFewEntries = await captureFilesystemSnapshot({
      limits: {
        maxDepth: 1,
        maxEntries: 1,
        maxFileBytes: 4,
        maxTotalBytes: 4,
      },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });
    const tooFewBytes = await captureFilesystemSnapshot({
      limits: {
        maxDepth: 1,
        maxEntries: 2,
        maxFileBytes: 4,
        maxTotalBytes: 3,
      },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });

    expect(exact.status).toBe('complete');
    expect(tooFewEntries).toMatchObject({
      error: { code: 'LIMIT_EXCEEDED', limit: 'maxEntries' },
      status: 'failed',
    });
    expect(tooFewBytes).toMatchObject({
      error: { code: 'LIMIT_EXCEEDED', limit: 'maxTotalBytes' },
      status: 'failed',
    });
  });

  it('distinguishes the per-file byte limit from the total byte limit', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    await writeFile(join(workspace, 'state', 'large.bin'), Buffer.alloc(5));

    const result = await captureFilesystemSnapshot({
      limits: {
        ...generousLimits,
        maxFileBytes: 4,
      },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: { code: 'LIMIT_EXCEEDED', limit: 'maxFileBytes' },
      status: 'failed',
    });
  });

  it('allows the configured depth and fails on the next level', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state', 'allowed', 'too-deep'), {
      recursive: true,
    });

    const result = await captureFilesystemSnapshot({
      limits: {
        ...generousLimits,
        maxDepth: 1,
      },
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: {
        code: 'LIMIT_EXCEEDED',
        limit: 'maxDepth',
        maximum: 1,
        observed: '2',
      },
      status: 'failed',
    });
  });

  it('fails closed for a descendant symbolic link or Windows junction', async () => {
    const workspace = await createWorkspace();
    const outside = await createWorkspace();
    await mkdir(join(workspace, 'state'));
    await writeFile(join(outside, 'secret.txt'), 'must not be read');
    await symlink(
      outside,
      join(workspace, 'state', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await captureFilesystemSnapshot({
      limits: generousLimits,
      roots: [{ alias: 'state', path: 'state' }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: {
        code: 'UNSAFE_PATH',
        reason: 'SYMLINK_OR_REPARSE_POINT',
      },
      status: 'failed',
    });
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });

  it('rejects an observer root that is a symbolic link or junction', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'real'));
    await symlink(
      join(workspace, 'real'),
      join(workspace, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await captureFilesystemSnapshot({
      limits: generousLimits,
      roots: [{ alias: 'state', path: 'linked' }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: {
        code: 'UNSAFE_PATH',
        reason: 'SYMLINK_OR_REPARSE_POINT',
      },
      status: 'failed',
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects special filesystem objects without attempting to read them',
    async () => {
      const workspace = await createWorkspace();
      await mkdir(join(workspace, 'state'));
      const socketPath = join(workspace, 'state', 'agent.sock');
      const server = createServer();
      openServers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });

      const result = await captureFilesystemSnapshot({
        limits: generousLimits,
        roots: [{ alias: 'state', path: 'state' }],
        workspaceRoot: workspace,
      });

      expect(result).toMatchObject({
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
        },
        status: 'failed',
      });
    },
  );

  it.each([
    ['absolute', process.platform === 'win32' ? 'C:/outside' : '/outside'],
    ['parent traversal', '../outside'],
    ['backslash', 'state\\child'],
    ['alternate data stream syntax', 'state:file'],
    ['Windows wildcard', 'state/ch*ld'],
    ['ambiguous replacement character', 'state/\uFFFDchild'],
    ['empty segment', 'state//child'],
  ])('rejects unsafe %s root paths', async (_label, observerPath) => {
    const workspace = await createWorkspace();

    const result = await captureFilesystemSnapshot({
      limits: generousLimits,
      roots: [{ alias: 'state', path: observerPath }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: { code: 'INVALID_CONFIG', field: 'roots' },
      status: 'failed',
    });
  });

  it('rejects overlapping roots and duplicate aliases', async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, 'state', 'nested'), { recursive: true });

    const overlap = await captureFilesystemSnapshot({
      limits: generousLimits,
      roots: [
        { alias: 'parent', path: 'state' },
        { alias: 'child', path: 'state/nested' },
      ],
      workspaceRoot: workspace,
    });
    const duplicateAlias = await captureFilesystemSnapshot({
      limits: generousLimits,
      roots: [
        { alias: 'state', path: 'state' },
        { alias: 'state', path: 'state/nested' },
      ],
      workspaceRoot: workspace,
    });

    expect(overlap).toMatchObject({
      error: { code: 'INVALID_CONFIG', reason: 'OVERLAPPING_ROOTS' },
      status: 'failed',
    });
    expect(duplicateAlias).toMatchObject({
      error: { code: 'INVALID_CONFIG', reason: 'DUPLICATE_ALIAS' },
      status: 'failed',
    });
  });

  it('rejects malformed limits before touching an observer root', async () => {
    const workspace = await createWorkspace();

    const result = await captureFilesystemSnapshot({
      limits: { ...generousLimits, maxEntries: 0 },
      roots: [{ alias: 'state', path: 'missing' }],
      workspaceRoot: workspace,
    });

    expect(result).toMatchObject({
      error: {
        code: 'INVALID_CONFIG',
        field: 'limits.maxEntries',
      },
      status: 'failed',
    });
  });
});

async function createWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ghostcase-filesystem-'));
  temporaryPaths.push(path);
  return path;
}

async function captureComplete(workspaceRoot: string): Promise<FilesystemSnapshot> {
  const result = await captureFilesystemSnapshot({
    limits: generousLimits,
    roots: [{ alias: 'state', path: 'state' }],
    workspaceRoot,
  });

  if (result.status !== 'complete') {
    throw new Error(`Expected a complete snapshot, received ${result.error.code}`);
  }
  return result;
}
