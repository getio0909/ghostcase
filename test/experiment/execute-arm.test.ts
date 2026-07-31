import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/config/index.js';
import type { CaseSpec, LoadedManifest } from '../../src/domain/model.js';
import { executeArm } from '../../src/experiment/execute-arm.js';
import type { SeedSnapshot } from '../../src/workspace/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('executeArm', () => {
  it('runs a fresh victim, snapshots after adapter setup, resets, and cleans the arm', async () => {
    const fixture = await armFixture();
    const victim = caseById(fixture.manifest, 'victim');

    const result = await executeArm({
      manifest: fixture.manifest,
      predecessorCases: [],
      seed: combinedSeed(),
      temporaryRoot: fixture.temporaryRoot,
      victimCase: victim,
    });

    if (result.status !== 'valid') {
      throw new Error(JSON.stringify(result));
    }
    expect(result.victim.outcome).toBe('pass');
    expect(result.victim.process.stdout).toMatchObject({
      bytes: 0,
      truncated: false,
    });
    expect(result.predecessorResidue.counts.total).toBe(0);
    expect(await readFile(fixture.resetMarker, 'utf8')).toBe('reset');
    await expect(noArmDirectories(fixture.temporaryRoot)).resolves.toBe(true);
  }, 30_000);

  it('returns a valid failing victim and the pure predecessor residue diff', async () => {
    const fixture = await armFixture();

    const result = await executeArm({
      manifest: fixture.manifest,
      predecessorCases: [caseById(fixture.manifest, 'polluter')],
      seed: combinedSeed(),
      temporaryRoot: fixture.temporaryRoot,
      victimCase: caseById(fixture.manifest, 'victim'),
    });

    if (result.status !== 'valid') {
      throw new Error(JSON.stringify(result));
    }
    expect(result.predecessors).toHaveLength(1);
    expect(result.predecessors[0]).toMatchObject({
      caseId: 'polluter',
      outcome: 'pass',
    });
    expect(result.victim).toMatchObject({
      caseId: 'victim',
      outcome: 'fail',
    });
    expect(result.predecessorResidue.counts).toMatchObject({
      added: 1,
      total: 1,
    });
    expect(result.predecessorResidue.changes[0]).toMatchObject({
      alias: 'workspace',
      kind: 'added',
    });
    expect(JSON.stringify(result)).not.toContain('pollution.json');
    expect(JSON.stringify(result)).not.toContain(fixture.suiteDir);
  }, 30_000);

  it('invalidates the arm when a predecessor oracle fails and still resets and cleans', async () => {
    const fixture = await armFixture();

    const result = await executeArm({
      manifest: fixture.manifest,
      predecessorCases: [caseById(fixture.manifest, 'failing')],
      seed: combinedSeed(),
      temporaryRoot: fixture.temporaryRoot,
      victimCase: caseById(fixture.manifest, 'victim'),
    });

    expect(result).toMatchObject({
      caseId: 'failing',
      phase: 'predecessor',
      reason: 'ORACLE_FAILED',
      status: 'invalid',
    });
    expect(await readFile(fixture.resetMarker, 'utf8')).toBe('reset');
    await expect(noArmDirectories(fixture.temporaryRoot)).resolves.toBe(true);
  }, 30_000);

  it('invalidates a timed-out victim without exposing process output or paths', async () => {
    const fixture = await armFixture();

    const result = await executeArm({
      manifest: fixture.manifest,
      predecessorCases: [],
      seed: combinedSeed(),
      temporaryRoot: fixture.temporaryRoot,
      victimCase: caseById(fixture.manifest, 'slow'),
    });

    expect(result).toMatchObject({
      caseId: 'slow',
      phase: 'victim',
      reason: 'PROCESS_ABNORMAL',
      status: 'invalid',
    });
    if (result.status !== 'invalid') {
      throw new Error('Expected an invalid arm.');
    }
    expect(result.process?.status).toBe('timed_out');
    expect(JSON.stringify(result)).not.toContain(fixture.suiteDir);
    expect(JSON.stringify(result)).not.toContain('private-output');
    expect(await readFile(fixture.resetMarker, 'utf8')).toBe('reset');
    await expect(noArmDirectories(fixture.temporaryRoot)).resolves.toBe(true);
  }, 30_000);

  it('does not mutate or reorder the caller-owned predecessor chain', async () => {
    const fixture = await armFixture();
    const first = caseById(fixture.manifest, 'pass-a');
    const second = caseById(fixture.manifest, 'pass-b');
    const predecessorCases = Object.freeze([first, second]);

    const result = await executeArm({
      manifest: fixture.manifest,
      predecessorCases,
      seed: combinedSeed(),
      temporaryRoot: fixture.temporaryRoot,
      victimCase: caseById(fixture.manifest, 'victim'),
    });

    if (result.status !== 'valid') {
      throw new Error(JSON.stringify(result));
    }
    expect(predecessorCases).toEqual([first, second]);
    expect(predecessorCases[0]).toBe(first);
    expect(predecessorCases[1]).toBe(second);
  }, 30_000);
});

interface ArmFixture {
  readonly manifest: LoadedManifest;
  readonly resetMarker: string;
  readonly suiteDir: string;
  readonly temporaryRoot: string;
}

async function armFixture(): Promise<ArmFixture> {
  const suiteDir = await temporaryDirectory('ghostcase-arm-suite-');
  const temporaryRoot = await temporaryDirectory('ghostcase-arm-root-');
  const script = join(suiteDir, 'agent.mjs');
  const resetMarker = join(suiteDir, 'reset-marker.txt');
  await writeFile(
    script,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const [action, argument] = process.argv.slice(2);',
      "if (action === 'adapter-setup') {",
      "  if (existsSync('adapter-setup.txt')) process.exitCode = 9;",
      "  else writeFileSync('adapter-setup.txt', 'ready');",
      '}',
      "if (action === 'pollute') writeFileSync('pollution.json', '{\"voice\":\"pirate\"}');",
      "if (action === 'victim' && existsSync('pollution.json')) process.exitCode = 7;",
      "if (action === 'fail') process.exitCode = 7;",
      "if (action === 'slow') {",
      "  process.stdout.write('private-output');",
      '  setInterval(() => undefined, 1_000);',
      '}',
      "if (action === 'reset' && argument) writeFileSync(argument, 'reset');",
    ].join('\n'),
    'utf8',
  );

  const definition = parseManifest({
    adapter: {
      reset: [
        {
          argv: [
            { path: { base: 'suite', path: 'agent.mjs' } },
            'reset',
            { path: { base: 'suite', path: 'reset-marker.txt' } },
          ],
          program: { lookup: 'node' },
          timeoutMs: 5_000,
        },
      ],
      run: {
        argv: [{ path: { base: 'suite', path: 'agent.mjs' } }],
        program: { lookup: 'node' },
        timeoutMs: 5_000,
      },
      setup: [
        {
          argv: [{ path: { base: 'suite', path: 'agent.mjs' } }, 'adapter-setup'],
          program: { lookup: 'node' },
          timeoutMs: 5_000,
        },
      ],
      snapshot: {
        roots: [{ root: 'workspace' }],
      },
    },
    cases: [
      { id: 'polluter', run: { argv: ['pollute'] } },
      { id: 'failing', run: { argv: ['fail'] } },
      { id: 'slow', run: { argv: ['slow'], timeoutMs: 500 } },
      { id: 'pass-a', run: { argv: ['pass'] } },
      { id: 'pass-b', run: { argv: ['pass'] } },
      { id: 'victim', run: { argv: ['victim'] } },
    ],
    execution: {
      armTimeoutMs: 60_000,
      caseTimeoutMs: 10_000,
      cleanupTimeoutMs: 10_000,
      maxSnapshotBytes: 1024 * 1024,
      maxSnapshotEntries: 100,
      maxSnapshotFileBytes: 1024 * 1024,
      maxStderrBytes: 4096,
      maxStdinBytes: 4096,
      maxStdoutBytes: 4096,
      stepTimeoutMs: 5_000,
      suiteTimeoutMs: 120_000,
    },
    schema: 'ghostcase/suite/v1',
    stateRoots: [{ id: 'workspace', seed: { kind: 'empty' } }],
    suite: {
      id: 'execute-arm-test',
      repetitions: 2,
    },
  });

  return {
    manifest: {
      definition,
      sourcePath: join(suiteDir, 'ghostcase.json'),
      sourceSha256: 'a'.repeat(64),
      stateRoots: [{ id: 'workspace', seed: { kind: 'empty' } }],
      suiteDir,
    },
    resetMarker,
    suiteDir,
    temporaryRoot,
  };
}

function combinedSeed(): SeedSnapshot {
  return Object.freeze({
    digest: 'b'.repeat(64),
    entries: Object.freeze([
      Object.freeze({ path: 'state', type: 'directory' as const }),
      Object.freeze({ path: 'state/workspace', type: 'directory' as const }),
      Object.freeze({ path: 'temp', type: 'directory' as const }),
    ]),
    totalBytes: 0,
  });
}

function caseById(manifest: LoadedManifest, id: string): CaseSpec {
  const selected = manifest.definition.cases.find((candidate) => candidate.id === id);
  if (selected === undefined) {
    throw new Error(`Missing test case ${id}.`);
  }
  return selected;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function noArmDirectories(temporaryRoot: string): Promise<boolean> {
  return (await readdir(temporaryRoot)).every((name) => !name.startsWith('ghostcase-arm-'));
}
