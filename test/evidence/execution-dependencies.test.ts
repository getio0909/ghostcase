import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadManifest } from '../../src/config/index.js';
import { EvidenceError } from '../../src/domain/errors.js';
import { captureExecutionDependencies } from '../../src/evidence/execution-dependencies.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('captureExecutionDependencies', () => {
  it('deterministically binds direct suite files and discloses unbound input classes', async () => {
    const fixture = await dependencyFixture();
    const first = await captureExecutionDependencies(fixture.manifest);
    const second = await captureExecutionDependencies(fixture.manifest);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      boundSuiteFiles: 3,
      unboundDynamicPathReferences: 4,
      unboundDynamicStdinFiles: 1,
      unboundLookupPrograms: 1,
      unboundSuitePathReferences: 2,
    });

    await writeFile(fixture.stdinPath, '8765', 'utf8');
    const changed = await captureExecutionDependencies(fixture.manifest);
    expect(changed.sha256).not.toBe(first.sha256);
  });

  it('allows exact limits and rejects one-byte file and aggregate overflows without paths', async () => {
    const fixture = await dependencyFixture();

    await expect(
      captureExecutionDependencies(fixture.manifest, {
        maxFileBytes: 4,
        maxTotalBytes: 12,
      }),
    ).resolves.toMatchObject({ boundSuiteFiles: 3 });

    const fileOverflow = await captureFailure(fixture, {
      maxFileBytes: 3,
      maxTotalBytes: 12,
    });
    expect(fileOverflow.message).toMatch(/file limit/iu);
    expect(fileOverflow.message).not.toContain(fixture.root);

    const totalOverflow = await captureFailure(fixture, {
      maxFileBytes: 4,
      maxTotalBytes: 11,
    });
    expect(totalOverflow.message).toMatch(/total limit/iu);
    expect(totalOverflow.message).not.toContain(fixture.root);
  });
});

interface DependencyFixture {
  readonly manifest: Awaited<ReturnType<typeof loadManifest>>;
  readonly root: string;
  readonly stdinPath: string;
}

async function dependencyFixture(): Promise<DependencyFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ghostcase-execution-dependencies-'));
  temporaryDirectories.push(root);
  const suiteDir = join(root, 'suite');
  await mkdir(suiteDir);
  const programPath = join(suiteDir, 'program.bin');
  const stdinPath = join(suiteDir, 'input.bin');
  const argumentPath = join(suiteDir, 'argument.bin');
  const assetsPath = join(suiteDir, 'assets');
  const manifestPath = join(suiteDir, 'ghostcase.json');
  await mkdir(assetsPath);
  await Promise.all([
    writeFile(programPath, '1234', 'utf8'),
    writeFile(stdinPath, '5678', 'utf8'),
    writeFile(argumentPath, 'abcd', 'utf8'),
  ]);
  await writeFile(
    manifestPath,
    JSON.stringify({
      adapter: {
        oracle: {
          equals: true,
          kind: 'fileJsonPointerEquals',
          path: 'oracle.json',
          pointer: '/ok',
        },
        run: {
          argv: [
            { path: { base: 'suite', path: 'argument.bin' } },
            { path: { base: 'suite', path: 'assets' } },
            { path: { base: 'suite', path: 'missing.bin' } },
            {
              path: {
                base: 'state',
                path: 'generated-argument.bin',
                root: 'workspace',
              },
            },
          ],
          env: {
            set: {
              GENERATED_TEMP: {
                path: { base: 'temp', path: 'generated-environment.bin' },
              },
            },
          },
          program: { path: 'program.bin' },
          stdin: {
            kind: 'file',
            path: { path: { base: 'suite', path: 'input.bin' } },
          },
        },
        setup: [
          {
            program: { lookup: 'node' },
            stdin: {
              kind: 'file',
              path: {
                path: { base: 'state', path: 'generated.bin', root: 'workspace' },
              },
            },
          },
        ],
        snapshot: { roots: [{ root: 'workspace' }] },
      },
      cases: [
        { id: 'control', run: { argv: [] } },
        { id: 'victim', run: { argv: [] } },
      ],
      schema: 'ghostcase/suite/v1',
      stateRoots: [{ id: 'workspace', seed: { kind: 'empty' } }],
      suite: { id: 'dependency-suite', repetitions: 2 },
    }),
    'utf8',
  );
  return {
    manifest: await loadManifest(manifestPath),
    root,
    stdinPath,
  };
}

async function captureFailure(
  fixture: DependencyFixture,
  limits: { readonly maxFileBytes: number; readonly maxTotalBytes: number },
): Promise<EvidenceError> {
  try {
    await captureExecutionDependencies(fixture.manifest, limits);
  } catch (error) {
    if (error instanceof EvidenceError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected dependency capture to fail.');
}
