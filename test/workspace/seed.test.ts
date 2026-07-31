import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FixtureError } from '../../src/domain/errors.js';
import { loadSeed, type SeedLimits } from '../../src/workspace/seed.js';

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

async function temporaryDirectory(prefix = 'ghostcase-seed-test-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSeed(order: 'forward' | 'reverse' = 'forward'): Promise<string> {
  const root = await temporaryDirectory();
  const operations = [
    async (): Promise<void> => {
      await mkdir(join(root, 'empty'));
    },
    async (): Promise<void> => {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'agent.mjs'), 'export const agent = true;\n', 'utf8');
    },
    async (): Promise<void> => {
      await writeFile(join(root, 'state.json'), '{"memory":[]}\n', 'utf8');
    },
  ];
  for (const operation of order === 'forward' ? operations : operations.reverse()) {
    await operation();
  }
  return root;
}

describe('loadSeed', () => {
  it('captures a stable portable snapshot including empty directories', async () => {
    const root = await createSeed();
    const snapshot = await loadSeed(root, limits);

    expect(snapshot.entries.map((entry) => `${entry.type}:${entry.path}`)).toEqual([
      'directory:empty',
      'directory:src',
      'file:src/agent.mjs',
      'file:state.json',
    ]);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.totalBytes).toBeGreaterThan(0);
  });

  it('produces the same digest for identical trees created in a different order', async () => {
    const first = await loadSeed(await createSeed('forward'), limits);
    const second = await loadSeed(await createSeed('reverse'), limits);

    expect(second.digest).toBe(first.digest);
    expect(second.entries).toEqual(first.entries);
  });

  it('preserves the executable bit on platforms that expose it', async () => {
    const root = await temporaryDirectory();
    const filename = join(root, 'agent');
    await writeFile(filename, '#!/usr/bin/env node\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(filename, 0o700);
    }

    const snapshot = await loadSeed(root, limits);
    const file = snapshot.entries.find((entry) => entry.type === 'file');
    expect(file?.type).toBe('file');
    expect(file?.type === 'file' ? file.executable : undefined).toBe(process.platform !== 'win32');
  });

  it('allows exact byte and entry limits and rejects limit plus one', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'data.bin'), Buffer.from([1, 2, 3, 4]));

    await expect(
      loadSeed(root, {
        maxDepth: 0,
        maxEntries: 1,
        maxFileBytes: 4,
        maxTotalBytes: 4,
      }),
    ).resolves.toMatchObject({ totalBytes: 4 });
    await expect(
      loadSeed(root, {
        maxDepth: 0,
        maxEntries: 1,
        maxFileBytes: 3,
        maxTotalBytes: 4,
      }),
    ).rejects.toThrow('byte limit');
    await expect(
      loadSeed(root, {
        maxDepth: 0,
        maxEntries: 0,
        maxFileBytes: 4,
        maxTotalBytes: 4,
      }),
    ).rejects.toThrow('maxEntries');
  });

  it('rejects nested content beyond the declared depth', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'one', 'two'), { recursive: true });
    await writeFile(join(root, 'one', 'two', 'value.txt'), 'value', 'utf8');

    await expect(loadSeed(root, { ...limits, maxDepth: 1 })).rejects.toThrow(
      'maximum directory depth',
    );
  });

  it('rejects directory links and junctions without reading their targets', async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory('ghostcase-external-test-');
    await writeFile(join(external, 'secret.txt'), 'sentinel-secret', 'utf8');
    await symlink(
      external,
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(loadSeed(root, limits)).rejects.toThrow(/links|junctions|reparse points/iu);
  });

  it('rejects a seed root reached through a directory link or junction', async () => {
    const target = await createSeed();
    const parent = await temporaryDirectory();
    const linkedRoot = join(parent, 'linked-seed');
    await symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(loadSeed(linkedRoot, limits)).rejects.toBeInstanceOf(FixtureError);
  });

  it.each([
    [{ ...limits, maxDepth: -1 }, 'maxDepth'],
    [{ ...limits, maxFileBytes: Number.NaN }, 'maxFileBytes'],
    [{ ...limits, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }, 'maxTotalBytes'],
  ])('rejects invalid limits', async (invalidLimits, expected) => {
    const root = await createSeed();
    await expect(loadSeed(root, invalidLimits)).rejects.toThrow(expected);
  });
});
