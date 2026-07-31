import { access, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FixtureError, HarnessError } from '../../src/domain/errors.js';
import { materializeSeed } from '../../src/workspace/materialize.js';
import { loadSeed, type SeedLimits, type SeedSnapshot } from '../../src/workspace/seed.js';

const temporaryDirectories: string[] = [];
const limits: SeedLimits = {
  maxDepth: 8,
  maxEntries: 20,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(prefix = 'ghostcase-materialize-test-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function snapshotFixture(): Promise<{ seedRoot: string; snapshot: SeedSnapshot }> {
  const seedRoot = await temporaryDirectory();
  await writeFile(join(seedRoot, 'state.json'), '{"voice":"neutral"}\n', 'utf8');
  return {
    seedRoot,
    snapshot: await loadSeed(seedRoot, limits),
  };
}

describe('materializeSeed', () => {
  it('creates byte-identical isolated workspaces without changing the seed', async () => {
    const temporaryRoot = await temporaryDirectory();
    const { seedRoot, snapshot } = await snapshotFixture();
    const first = await materializeSeed(snapshot, { temporaryRoot });
    const second = await materializeSeed(snapshot, { temporaryRoot });

    await writeFile(join(first.root, 'state.json'), '{"voice":"pirate"}\n', 'utf8');

    expect(await readFile(join(second.root, 'state.json'), 'utf8')).toBe('{"voice":"neutral"}\n');
    expect(await readFile(join(seedRoot, 'state.json'), 'utf8')).toBe('{"voice":"neutral"}\n');
    expect(first.root).not.toBe(second.root);
    await first.cleanup();
    await second.cleanup();
  });

  it('cleans a workspace idempotently', async () => {
    const temporaryRoot = await temporaryDirectory();
    const { snapshot } = await snapshotFixture();
    const workspace = await materializeSeed(snapshot, { temporaryRoot });

    await workspace.cleanup();
    await workspace.cleanup();

    await expect(access(workspace.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe snapshot paths and removes the partial workspace', async () => {
    const temporaryRoot = await temporaryDirectory();
    const unsafe: SeedSnapshot = {
      digest: '0'.repeat(64),
      entries: [{ path: '../escape', type: 'directory' }],
      totalBytes: 0,
    };

    await expect(materializeSeed(unsafe, { temporaryRoot })).rejects.toBeInstanceOf(FixtureError);
    expect(await readFileOrDirectoryNames(temporaryRoot)).toEqual([]);
  });

  it('rejects corrupted in-memory file content and removes the partial workspace', async () => {
    const temporaryRoot = await temporaryDirectory();
    const corrupted: SeedSnapshot = {
      digest: '0'.repeat(64),
      entries: [
        {
          contentBase64: Buffer.from('changed').toString('base64'),
          executable: false,
          path: 'state.json',
          sha256: '0'.repeat(64),
          size: 7,
          type: 'file',
        },
      ],
      totalBytes: 7,
    };

    await expect(materializeSeed(corrupted, { temporaryRoot })).rejects.toThrow('integrity check');
    expect(await readFileOrDirectoryNames(temporaryRoot)).toEqual([]);
  });

  it('rejects a temporary root reached through a link or junction', async () => {
    const target = await temporaryDirectory();
    const parent = await temporaryDirectory();
    const linked = join(parent, 'linked-temp');
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const { snapshot } = await snapshotFixture();

    await expect(materializeSeed(snapshot, { temporaryRoot: linked })).rejects.toBeInstanceOf(
      HarnessError,
    );
  });

  it.each(['x', '../arm-', 'arm/path-', 'arm\\path-', `arm\0path-`])(
    'rejects an unsafe workspace prefix',
    async (prefix) => {
      const temporaryRoot = await temporaryDirectory();
      const { snapshot } = await snapshotFixture();

      await expect(materializeSeed(snapshot, { prefix, temporaryRoot })).rejects.toThrow('prefix');
    },
  );
});

async function readFileOrDirectoryNames(directory: string): Promise<string[]> {
  return readdir(directory);
}
