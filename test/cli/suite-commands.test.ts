import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatSuiteCommand,
  runSuiteCommand,
  type SuiteCommandData,
} from '../../src/cli/suite-commands.js';
import { ConfigError, FixtureError, HarnessError } from '../../src/domain/errors.js';

const temporaryDirectories: string[] = [];
const secretCanary = 'doctor-secret-canary-931f';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

interface SuiteFixture {
  readonly directory: string;
  readonly manifestPath: string;
  readonly markerPath: string;
}

async function createSuite(): Promise<SuiteFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-suite-command-test-'));
  temporaryDirectories.push(directory);
  const seedDirectory = join(directory, 'seed');
  const markerPath = join(directory, 'executed.marker');
  const manifestPath = join(directory, 'ghostcase.json');
  await mkdir(seedDirectory);
  await writeFile(join(seedDirectory, 'memory.json'), '{"persona":"neutral"}\n', 'utf8');
  await writeFile(
    join(directory, 'agent.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('executed.marker', import.meta.url), 'executed\\n', 'utf8');",
    ].join('\n'),
    'utf8',
  );
  await writeFile(manifestPath, `${JSON.stringify(manifestDefinition(), null, 2)}\n`, 'utf8');
  return { directory, manifestPath, markerPath };
}

function manifestDefinition(
  stdin: Record<string, unknown> = {
    kind: 'text',
    value: secretCanary,
  },
): Record<string, unknown> {
  const lifecycleCommand = {
    program: { lookup: 'node' },
    argv: [{ path: { base: 'suite', path: 'agent.mjs' } }],
  };
  return {
    schema: 'ghostcase/suite/v1',
    suite: {
      id: 'suite-command-test',
      repetitions: 2,
      search: {
        maxChainLength: 4,
        maxExperiments: 32,
      },
    },
    stateRoots: [
      {
        id: 'memory',
        seed: {
          kind: 'copy',
          path: 'seed',
        },
      },
    ],
    environment: {
      set: {
        SECRET_CANARY: secretCanary,
      },
    },
    execution: {
      stepTimeoutMs: 1_000,
      caseTimeoutMs: 2_000,
      armTimeoutMs: 4_000,
      suiteTimeoutMs: 8_000,
      cleanupTimeoutMs: 1_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      maxStdinBytes: 4_096,
      maxSnapshotEntries: 32,
      maxSnapshotFileBytes: 4_096,
      maxSnapshotBytes: 8_192,
    },
    adapter: {
      setup: [lifecycleCommand],
      run: {
        ...lifecycleCommand,
        stdin,
      },
      reset: [lifecycleCommand],
      snapshot: {
        roots: [{ root: 'memory' }],
      },
    },
    cases: [
      {
        id: 'polluter',
        platforms: ['linux'],
        tags: ['writer'],
        setup: [lifecycleCommand],
        run: {
          argv: ['polluter'],
        },
      },
      {
        id: 'victim',
        platforms: ['win32', 'linux'],
        tags: ['victim'],
        run: {
          argv: ['victim'],
        },
      },
    ],
  };
}

describe('runSuiteCommand', () => {
  it('validates syntax and fixtures into safe deterministic metadata', async () => {
    const fixture = await createSuite();
    const first = await runSuiteCommand('validate', fixture.manifestPath);
    const second = await runSuiteCommand('validate', fixture.manifestPath);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      exitCode: 0,
      data: {
        command: 'validate',
        schema: 'ghostcase/suite/v1',
        suite: { id: 'suite-command-test' },
        cases: {
          count: 2,
          ids: ['polluter', 'victim'],
        },
        prepared: {
          entries: 4,
          totalBytes: 22,
        },
        stateRoots: [
          {
            id: 'memory',
            kind: 'copy',
            totalBytes: 22,
          },
        ],
      },
    });
    expect(first.data.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.data.prepared.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(safeStrings(first.data)).not.toContain(fixture.directory);
    expect(JSON.stringify(first)).not.toContain(secretCanary);
  });

  it('inspects bounded execution, search, programs, and case contracts without secrets', async () => {
    const fixture = await createSuite();
    const result = await runSuiteCommand('inspect', fixture.manifestPath);

    expect(result).toMatchObject({
      exitCode: 0,
      data: {
        command: 'inspect',
        adapter: {
          argvCount: 1,
          program: {
            kind: 'lookup',
            name: 'node',
          },
          resetCommandCount: 1,
          setupCommandCount: 1,
          snapshotRoots: ['memory'],
        },
        search: {
          maxChainLength: 4,
          maxExperiments: 32,
          repetitions: 2,
        },
        casePlans: [
          {
            argvCount: 1,
            id: 'polluter',
            mergedArgvCount: 2,
            platforms: ['linux'],
            setupCommandCount: 1,
            tags: ['writer'],
          },
          {
            argvCount: 1,
            id: 'victim',
            mergedArgvCount: 2,
            platforms: ['win32', 'linux'],
            setupCommandCount: 0,
            tags: ['victim'],
          },
        ],
      },
    });
    const output = formatSuiteCommand(result, 'json');
    expect(output).not.toContain(fixture.directory);
    expect(output).not.toContain(secretCanary);
    expect(output).not.toContain('SECRET_CANARY');
  });

  it('doctors an isolated clone without executing commands and removes the clone', async () => {
    const fixture = await createSuite();
    const before = await doctorWorkspaceNames();
    const manifestBefore = await readFile(fixture.manifestPath, 'utf8');

    const result = await runSuiteCommand('doctor', fixture.manifestPath);

    expect(result).toMatchObject({
      exitCode: 0,
      data: {
        command: 'doctor',
        checks: {
          commands: 'ok',
          fixtures: 'ok',
          manifest: 'ok',
          materialize: 'ok',
          snapshot: 'ok',
        },
        resolvedCommandCount: 6,
        stdinContentsChecked: false,
        snapshot: {
          entries: 2,
          roots: ['memory'],
          totalBytes: 22,
        },
      },
    });
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await doctorWorkspaceNames()).toEqual(before);
    expect(await readFile(fixture.manifestPath, 'utf8')).toBe(manifestBefore);
    expect(safeStrings(result.data)).not.toContain(fixture.directory);
    expect(JSON.stringify(result)).not.toContain(secretCanary);
  });

  it('validates file stdin metadata without reading its contents', async () => {
    const fixture = await createSuite();
    const stdinPath = join(fixture.directory, 'request.bin');
    await writeFile(stdinPath, secretCanary, 'utf8');
    if (process.platform !== 'win32') {
      await chmod(stdinPath, 0);
    }
    await writeManifest(fixture, manifestDefinition(fileStdin('request.bin')), 'file-stdin.json');

    const result = await runSuiteCommand('doctor', join(fixture.directory, 'file-stdin.json'));

    expect(result.data).toMatchObject({
      command: 'doctor',
      stdinContentsChecked: false,
    });
    expect(JSON.stringify(result)).not.toContain(secretCanary);
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['missing file', 'missing.bin', undefined, 'Unable to inspect a command stdin file.'],
    ['directory', 'seed', undefined, 'not a permitted regular'],
    [
      'oversized file',
      'oversized.bin',
      Buffer.alloc(4_097, 0x61),
      'exceeds its configured byte limit',
    ],
  ] satisfies readonly (readonly [string, string, Buffer | undefined, string])[])(
    'rejects %s stdin metadata',
    async (_label, path, contents, causeMessage) => {
      const fixture = await createSuite();
      if (contents !== undefined) {
        await writeFile(join(fixture.directory, path), contents);
      }
      const manifestPath = await writeManifest(
        fixture,
        manifestDefinition(fileStdin(path)),
        'invalid-stdin.json',
      );

      await expectDoctorCause(manifestPath, causeMessage);
    },
  );

  it('rejects a final stdin link without reading its target', async () => {
    const fixture = await createSuite();
    const target = join(fixture.directory, 'target.bin');
    await writeFile(target, secretCanary, 'utf8');
    const linked = join(fixture.directory, 'linked.bin');
    if (!(await createFileLink(target, linked))) {
      return;
    }
    const manifestPath = await writeManifest(
      fixture,
      manifestDefinition(fileStdin('linked.bin')),
      'linked-stdin.json',
    );

    await expectDoctorCause(
      manifestPath,
      'A command stdin file is not a permitted regular non-link file.',
    );
  });

  it('rejects stdin that escapes its typed suite root through a linked directory', async () => {
    const fixture = await createSuite();
    const outside = await mkdtemp(join(tmpdir(), 'ghostcase-stdin-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'request.bin'), secretCanary, 'utf8');
    const linkedDirectory = join(fixture.directory, 'escape');
    if (!(await createDirectoryLink(outside, linkedDirectory))) {
      return;
    }
    const manifestPath = await writeManifest(
      fixture,
      manifestDefinition(fileStdin('escape/request.bin')),
      'escaping-stdin.json',
    );

    await expectDoctorCause(manifestPath, /escaped|non-link/u);
  });

  it('validates stdin on every merged adapter and case command', async () => {
    const fixture = await createSuite();
    const definition = manifestDefinition({ kind: 'none' });
    setCaseStdin(definition, 0, fileStdin('case-input-missing.bin'));
    const manifestPath = await writeManifest(fixture, definition, 'case-stdin.json');

    await expectDoctorCause(manifestPath, 'Unable to inspect a command stdin file.');
  });

  it.each([
    ['state', 'memory'],
    ['temp', undefined],
  ] as const)(
    'allows an unmaterialized %s stdin file that setup may create',
    async (base, root) => {
      const fixture = await createSuite();
      const definition = manifestDefinition({ kind: 'none' });
      setCaseStdin(definition, 0, fileStdin('generated/request.bin', base, root));
      const manifestPath = await writeManifest(fixture, definition, `${base}-dynamic-stdin.json`);

      await expect(runSuiteCommand('doctor', manifestPath)).resolves.toMatchObject({
        exitCode: 0,
        data: {
          command: 'doctor',
          stdinContentsChecked: false,
        },
      });
    },
  );

  it('throws typed errors for an invalid manifest and a missing fixture', async () => {
    const fixture = await createSuite();
    const invalidPath = join(fixture.directory, 'invalid.json');
    await writeFile(
      invalidPath,
      `${JSON.stringify({ ...manifestDefinition(), unexpected: true })}\n`,
      'utf8',
    );
    await expect(runSuiteCommand('validate', invalidPath)).rejects.toBeInstanceOf(ConfigError);

    const missing = manifestDefinition();
    const stateRoots = missing.stateRoots;
    if (!Array.isArray(stateRoots)) {
      throw new Error('Expected state roots in the test manifest.');
    }
    stateRoots[0] = {
      id: 'memory',
      seed: {
        kind: 'copy',
        path: 'missing-seed',
      },
    };
    const missingPath = join(fixture.directory, 'missing.json');
    await writeFile(missingPath, `${JSON.stringify(missing)}\n`, 'utf8');
    await expect(runSuiteCommand('validate', missingPath)).rejects.toBeInstanceOf(FixtureError);
  });
});

describe('formatSuiteCommand', () => {
  it('emits canonical JSON and readable human output with exactly one trailing newline', async () => {
    const fixture = await createSuite();
    const result = await runSuiteCommand('inspect', fixture.manifestPath);
    const before = JSON.stringify(result);

    const jsonFirst = formatSuiteCommand(result, 'json');
    const jsonSecond = formatSuiteCommand(result, 'json');
    const humanFirst = formatSuiteCommand(result, 'human');
    const humanSecond = formatSuiteCommand(result, 'human');

    expect(jsonFirst).toBe(jsonSecond);
    expect(JSON.parse(jsonFirst)).toEqual(result);
    expect(jsonFirst.endsWith('\n')).toBe(true);
    expect(jsonFirst.endsWith('\n\n')).toBe(false);
    expect(jsonFirst.indexOf('"data"')).toBeLessThan(jsonFirst.indexOf('"exitCode"'));
    expect(humanFirst).toBe(humanSecond);
    expect(humanFirst).toContain('GhostCase suite inspection\nSuite: suite-command-test');
    expect(humanFirst.endsWith('\n')).toBe(true);
    expect(humanFirst.endsWith('\n\n')).toBe(false);
    expect(JSON.stringify(result)).toBe(before);
  });
});

function safeStrings(data: SuiteCommandData): string[] {
  const strings: string[] = [];
  collectStrings(data, strings);
  return strings;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, output);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectStrings(entry, output);
    }
  }
}

async function doctorWorkspaceNames(): Promise<readonly string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith('ghostcase-doctor-')).sort();
}

function fileStdin(
  path: string,
  base: 'state' | 'suite' | 'temp' = 'suite',
  root?: string,
): Record<string, unknown> {
  return {
    kind: 'file',
    path: {
      path: {
        base,
        path,
        ...(root === undefined ? {} : { root }),
      },
    },
  };
}

async function writeManifest(
  fixture: SuiteFixture,
  definition: Record<string, unknown>,
  name: string,
): Promise<string> {
  const path = join(fixture.directory, name);
  await writeFile(path, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  return path;
}

function setCaseStdin(
  definition: Record<string, unknown>,
  caseIndex: number,
  stdin: Record<string, unknown>,
): void {
  const cases = definition.cases;
  if (!Array.isArray(cases)) {
    throw new Error('Expected cases in the test manifest.');
  }
  const caseSpec: unknown = cases[caseIndex];
  if (caseSpec === null || typeof caseSpec !== 'object' || Array.isArray(caseSpec)) {
    throw new Error('Expected a case object in the test manifest.');
  }
  const run = (caseSpec as Record<string, unknown>).run;
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('Expected a case run object in the test manifest.');
  }
  (run as Record<string, unknown>).stdin = stdin;
}

async function expectDoctorCause(manifestPath: string, expected: string | RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await runSuiteCommand('doctor', manifestPath);
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HarnessError);
  if (!(thrown instanceof HarnessError)) {
    return;
  }
  expect(thrown.cause).toBeInstanceOf(HarnessError);
  if (!(thrown.cause instanceof HarnessError)) {
    return;
  }
  if (typeof expected === 'string') {
    expect(thrown.cause.message).toContain(expected);
  } else {
    expect(thrown.cause.message).toMatch(expected);
  }
}

async function createFileLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error) {
      const code = error.code;
      if (code === 'EPERM' || code === 'EACCES') {
        return false;
      }
    }
    throw error;
  }
}

async function createDirectoryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error) {
      const code = error.code;
      if (code === 'EPERM' || code === 'EACCES') {
        return false;
      }
    }
    throw error;
  }
}
