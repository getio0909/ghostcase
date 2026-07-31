import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadManifest } from '../../src/config/index.js';
import type { LoadedManifest } from '../../src/domain/model.js';
import { FixtureError } from '../../src/domain/errors.js';
import {
  DEFAULT_SEED_LIMITS,
  materializeSeed,
  prepareSuite,
  type PreparedSuite,
  type SeedLimits,
} from '../../src/workspace/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-prepare-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface RootFixture {
  readonly files?: Readonly<Record<string, string | Buffer>>;
  readonly id: string;
  readonly kind: 'copy' | 'empty';
}

async function loadedManifest(
  roots: readonly RootFixture[],
  execution: Readonly<Record<string, number>> = {},
): Promise<LoadedManifest> {
  const suiteDirectory = await temporaryDirectory();
  const stateRoots = [];

  for (const root of roots) {
    if (root.kind === 'empty') {
      stateRoots.push({ id: root.id, seed: { kind: 'empty' } });
      continue;
    }

    const relativeSeedPath = `fixtures/${root.id}`;
    const absoluteSeedPath = join(suiteDirectory, 'fixtures', root.id);
    await mkdir(absoluteSeedPath, { recursive: true });
    for (const [path, content] of Object.entries(root.files ?? {})) {
      const target = join(absoluteSeedPath, ...path.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
    stateRoots.push({
      id: root.id,
      seed: { kind: 'copy', path: relativeSeedPath },
    });
  }

  const manifestPath = join(suiteDirectory, 'ghostcase.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      adapter: {
        run: {
          argv: ['-e', 'process.exit(0)'],
          program: { lookup: 'node' },
        },
        snapshot: { roots: [{ root: roots[0]?.id }] },
      },
      cases: [
        { id: 'first', run: { argv: [] } },
        { id: 'second', run: { argv: [] } },
      ],
      execution,
      schema: 'ghostcase/suite/v1',
      stateRoots,
      suite: { id: 'prepare-test' },
    }),
    'utf8',
  );
  return loadManifest(manifestPath);
}

function entryLabels(prepared: PreparedSuite): string[] {
  return prepared.snapshot.entries.map((entry) => `${entry.type}:${entry.path}`);
}

describe('prepareSuite', () => {
  it('combines copy and empty roots into the fixed isolated workspace layout', async () => {
    const manifest = await loadedManifest([
      {
        files: {
          'memory/profile.json': '{"voice":"neutral"}\n',
          'scratch.txt': 'seed\n',
        },
        id: 'workspace',
        kind: 'copy',
      },
      { id: 'cache', kind: 'empty' },
    ]);

    const prepared = await prepareSuite(manifest);

    expect(entryLabels(prepared)).toEqual([
      'directory:state',
      'directory:state/cache',
      'directory:state/workspace',
      'directory:state/workspace/memory',
      'file:state/workspace/memory/profile.json',
      'file:state/workspace/scratch.txt',
      'directory:temp',
    ]);
    expect(prepared.snapshot.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.snapshot.totalBytes).toBe(
      Buffer.byteLength('{"voice":"neutral"}\nseed\n', 'utf8'),
    );
    expect(
      prepared.stateRoots.map(({ sourceDigest, ...root }) => ({
        ...root,
        sourceDigestIsValid: /^[a-f0-9]{64}$/u.test(sourceDigest),
      })),
    ).toEqual([
      {
        id: 'cache',
        kind: 'empty',
        sourceDigestIsValid: true,
        totalBytes: 0,
      },
      {
        id: 'workspace',
        kind: 'copy',
        sourceDigestIsValid: true,
        totalBytes: Buffer.byteLength('{"voice":"neutral"}\nseed\n', 'utf8'),
      },
    ]);

    const workspace = await materializeSeed(prepared.snapshot, {
      temporaryRoot: await temporaryDirectory(),
    });
    expect(await readFile(join(workspace.root, 'state', 'workspace', 'scratch.txt'), 'utf8')).toBe(
      'seed\n',
    );
    expect(await readdir(join(workspace.root, 'state', 'cache'))).toEqual([]);
    await workspace.cleanup();
  });

  it('is deterministic across source creation and manifest root order', async () => {
    const first = await prepareSuite(
      await loadedManifest([
        { files: { 'z.txt': 'z', 'a.txt': 'a' }, id: 'zeta', kind: 'copy' },
        { files: { 'b.txt': 'b' }, id: 'alpha', kind: 'copy' },
      ]),
    );
    const second = await prepareSuite(
      await loadedManifest([
        { files: { 'b.txt': 'b' }, id: 'alpha', kind: 'copy' },
        { files: { 'a.txt': 'a', 'z.txt': 'z' }, id: 'zeta', kind: 'copy' },
      ]),
    );

    expect(second).toEqual(first);
    expect(second.snapshot.digest).toBe(first.snapshot.digest);
  });

  it('deep-freezes the prepared value and remains unchanged after source tampering', async () => {
    const manifest = await loadedManifest([
      { files: { 'memory.txt': 'original' }, id: 'workspace', kind: 'copy' },
    ]);
    const prepared = await prepareSuite(manifest);
    const copiedFile = prepared.snapshot.entries.find((entry) => entry.type === 'file');
    const sourcePath = manifest.stateRoots[0]?.seed;
    if (sourcePath?.kind !== 'copy') {
      throw new Error('Expected a copy seed fixture.');
    }

    await writeFile(join(sourcePath.resolvedPath, 'memory.txt'), 'tampered', 'utf8');

    expect(
      Buffer.from(copiedFile?.type === 'file' ? copiedFile.contentBase64 : '', 'base64').toString(
        'utf8',
      ),
    ).toBe('original');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.snapshot)).toBe(true);
    expect(Object.isFrozen(prepared.snapshot.entries)).toBe(true);
    expect(Object.isFrozen(prepared.snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(prepared.stateRoots)).toBe(true);
    expect(Object.isFrozen(prepared.stateRoots[0])).toBe(true);
    expect(() => {
      Object.defineProperty(prepared.stateRoots[0], 'totalBytes', { value: 99 });
    }).toThrow(TypeError);
  });

  it('uses controlled defaults and caps them by manifest snapshot limits', async () => {
    expect(DEFAULT_SEED_LIMITS).toEqual({
      maxDepth: 64,
      maxEntries: 10_000,
      maxFileBytes: 16 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    });
    expect(Object.isFrozen(DEFAULT_SEED_LIMITS)).toBe(true);

    const manifest = await loadedManifest(
      [{ files: { 'four.bin': Buffer.from([1, 2, 3, 4]) }, id: 'workspace', kind: 'copy' }],
      {
        maxSnapshotBytes: 3,
        maxSnapshotEntries: 10,
        maxSnapshotFileBytes: 3,
      },
    );

    await expect(prepareSuite(manifest)).rejects.toThrow(/file|byte limit/iu);
  });

  it('rejects aggregate bytes and entries that only exceed the budget across roots', async () => {
    const manifest = await loadedManifest([
      { files: { 'one.bin': Buffer.from([1, 2, 3]) }, id: 'firstroot', kind: 'copy' },
      { files: { 'two.bin': Buffer.from([4, 5, 6]) }, id: 'secondroot', kind: 'copy' },
    ]);
    const byteLimits: SeedLimits = {
      maxDepth: 8,
      maxEntries: 20,
      maxFileBytes: 4,
      maxTotalBytes: 5,
    };
    const entryLimits: SeedLimits = {
      ...byteLimits,
      maxEntries: 5,
      maxTotalBytes: 10,
    };

    await expect(prepareSuite(manifest, byteLimits)).rejects.toThrow('total byte limit');
    await expect(prepareSuite(manifest, entryLimits)).rejects.toThrow('entry limit');
  });

  it('rejects duplicate root paths before producing an ambiguous combined snapshot', async () => {
    const manifest = await loadedManifest([
      { files: { 'state.txt': 'safe' }, id: 'workspace', kind: 'copy' },
    ]);
    const firstRoot = manifest.stateRoots[0];
    if (firstRoot === undefined) {
      throw new Error('Expected one state root fixture.');
    }
    const duplicate: LoadedManifest = {
      ...manifest,
      stateRoots: [firstRoot, firstRoot],
    };

    await expect(prepareSuite(duplicate)).rejects.toBeInstanceOf(FixtureError);
    await expect(prepareSuite(duplicate)).rejects.toThrow(/duplicate|path/iu);
  });

  it.each([
    [{ ...DEFAULT_SEED_LIMITS, maxDepth: -1 }, 'maxDepth'],
    [{ ...DEFAULT_SEED_LIMITS, maxEntries: 0 }, 'maxEntries'],
    [{ ...DEFAULT_SEED_LIMITS, maxFileBytes: Number.NaN }, 'maxFileBytes'],
    [{ ...DEFAULT_SEED_LIMITS, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }, 'maxTotalBytes'],
  ])('rejects invalid explicit limits', async (limits, expected) => {
    const manifest = await loadedManifest([{ id: 'workspace', kind: 'empty' }]);

    await expect(prepareSuite(manifest, limits)).rejects.toThrow(expected);
  });

  it('does not place suite source paths or later file contents in metadata', async () => {
    const manifest = await loadedManifest([
      { files: { 'private.txt': 'safe-fixture' }, id: 'workspace', kind: 'copy' },
    ]);
    const prepared = await prepareSuite(manifest);

    const metadataJson = JSON.stringify(prepared.stateRoots);
    expect(metadataJson).not.toContain(manifest.suiteDir);
    expect(metadataJson).not.toContain('safe-fixture');
    expect(await readFile(manifest.sourcePath, 'utf8')).toContain('workspace');
  });
});
