import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_EXECUTION,
  DEFAULT_SEARCH,
  MANIFEST_FILE_MAX_BYTES,
  MANIFEST_HARD_LIMITS,
  loadManifest,
  parseManifest,
} from '../../src/config/index.js';
import type { ConfigError } from '../../src/domain/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

function minimalManifest(): Record<string, unknown> {
  return {
    adapter: {
      run: {
        argv: [
          {
            path: {
              base: 'suite',
              path: 'fixtures/fake-agent.mjs',
            },
          },
        ],
        program: { lookup: 'node' },
      },
      snapshot: {
        roots: [{ root: 'workspace' }],
      },
    },
    cases: [
      {
        id: 'polluter',
        run: { argv: ['--case', 'polluter'] },
      },
      {
        id: 'victim',
        run: { argv: ['--case', 'victim'] },
      },
    ],
    schema: 'ghostcase/suite/v1',
    stateRoots: [
      {
        id: 'workspace',
        seed: { kind: 'copy', path: 'fixtures/workspace' },
      },
      {
        id: 'memory',
        seed: { kind: 'empty' },
      },
    ],
    suite: {
      id: 'memory-pollution',
    },
  };
}

describe('parseManifest', () => {
  it('fills every canonical default without retaining input objects', () => {
    const input = minimalManifest();
    const parsed = parseManifest(input);

    expect(parsed).toMatchObject({
      adapter: {
        oracle: { kind: 'exitCodeEquals', value: 0 },
        reset: [],
        run: {
          cwd: { base: 'state', path: '.', root: 'workspace' },
          env: { set: {}, unset: [] },
          stdin: { kind: 'none' },
          timeoutMs: DEFAULT_EXECUTION.stepTimeoutMs,
        },
        setup: [],
        snapshot: {
          roots: [{ root: 'workspace' }],
        },
      },
      environment: DEFAULT_ENVIRONMENT,
      execution: DEFAULT_EXECUTION,
      schema: 'ghostcase/suite/v1',
      suite: {
        description: '',
        id: 'memory-pollution',
        repetitions: 3,
        search: DEFAULT_SEARCH,
      },
    });
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('parses argv path references, state env values, setup/reset, case overrides, and oracles', () => {
    const input = minimalManifest();
    input.environment = {
      inherit: ['PATH'],
      set: { CI: '1' },
      unset: ['NO_COLOR'],
    };
    input.adapter = {
      oracle: {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/ok',
        equals: true,
      },
      reset: [
        {
          program: { lookup: 'node' },
          argv: [{ path: { base: 'suite', path: 'fixtures/reset.mjs' } }],
        },
      ],
      run: {
        program: { lookup: 'node' },
        argv: [{ path: { base: 'suite', path: 'fixtures/fake-agent.mjs' } }],
        env: {
          set: {
            MEMORY_DIR: { path: { base: 'state', root: 'memory', path: '.' } },
          },
        },
      },
      setup: [
        {
          program: { path: 'bin/setup.exe' },
          argv: [],
        },
      ],
      snapshot: {
        roots: [{ root: 'memory' }],
      },
    };
    const cases = input.cases as Record<string, unknown>[];
    cases[0] = {
      id: 'polluter',
      platforms: ['linux'],
      setup: [
        {
          program: { lookup: 'node' },
          argv: [{ path: { base: 'suite', path: 'fixtures/prepare.mjs' } }],
        },
      ],
      run: {
        argv: ['--case', 'polluter'],
        cwd: { base: 'state', root: 'memory', path: '.' },
        env: { set: { MODE: 'pollute' }, unset: [] },
        stdin: { kind: 'text', value: '{"pollute":true}' },
        timeoutMs: 10_000,
      },
      oracle: { kind: 'exitCodeEquals', value: 7 },
    };

    expect(parseManifest(input)).toMatchObject({
      adapter: {
        oracle: { kind: 'stdoutJsonPointerEquals', pointer: '/ok', equals: true },
        setup: [{ program: { path: 'bin/setup.exe' } }],
      },
      cases: [
        {
          id: 'polluter',
          oracle: { kind: 'exitCodeEquals', value: 7 },
          platforms: ['linux'],
          run: {
            cwd: { base: 'state', root: 'memory', path: '.' },
            timeoutMs: 10_000,
          },
        },
        { id: 'victim' },
      ],
      environment: {
        inherit: ['PATH'],
        set: { CI: '1' },
        unset: ['NO_COLOR'],
      },
    });
  });

  it.each([
    [
      'root',
      (input: Record<string, unknown>): void => {
        input.unknown = true;
      },
      "$ contains unknown field 'unknown'.",
    ],
    [
      'suite',
      (input: Record<string, unknown>): void => {
        (input.suite as Record<string, unknown>).unknown = true;
      },
      "$.suite contains unknown field 'unknown'.",
    ],
    [
      'state root',
      (input: Record<string, unknown>): void => {
        recordAt(input.stateRoots, 0).unknown = true;
      },
      "$.stateRoots[0] contains unknown field 'unknown'.",
    ],
    [
      'adapter',
      (input: Record<string, unknown>): void => {
        (input.adapter as Record<string, unknown>).unknown = true;
      },
      "$.adapter contains unknown field 'unknown'.",
    ],
    [
      'command',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as { run: Record<string, unknown> };
        adapter.run.unknown = true;
      },
      "$.adapter.run contains unknown field 'unknown'.",
    ],
    [
      'snapshot root filter',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as {
          snapshot: { roots: Record<string, unknown>[] };
        };
        recordAt(adapter.snapshot.roots, 0).include = ['**'];
      },
      "$.adapter.snapshot.roots[0] contains unknown field 'include'.",
    ],
    [
      'snapshot root exclusion',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as {
          snapshot: { roots: Record<string, unknown>[] };
        };
        recordAt(adapter.snapshot.roots, 0).exclude = ['cache/**'];
      },
      "$.adapter.snapshot.roots[0] contains unknown field 'exclude'.",
    ],
    [
      'environment',
      (input: Record<string, unknown>): void => {
        input.environment = { unknown: true };
      },
      "$.environment contains unknown field 'unknown'.",
    ],
    [
      'execution',
      (input: Record<string, unknown>): void => {
        input.execution = { killGraceMs: 1000 };
      },
      "$.execution contains unknown field 'killGraceMs'.",
    ],
    [
      'case',
      (input: Record<string, unknown>): void => {
        recordAt(input.cases, 0).unknown = true;
      },
      "$.cases[0] contains unknown field 'unknown'.",
    ],
  ])('rejects unknown fields in the %s object', (_label, mutate, message) => {
    const input = minimalManifest();
    mutate(input);

    expect(() => parseManifest(input)).toThrow(
      expect.objectContaining<Partial<ConfigError>>({
        code: 'CONFIG_ERROR',
        message,
      }),
    );
  });

  it.each([
    [
      'schema',
      (input: Record<string, unknown>): void => {
        input.schema = 'ghostcase/suite/v2';
      },
      "$.schema must equal 'ghostcase/suite/v1'.",
    ],
    [
      'suite id',
      (input: Record<string, unknown>): void => {
        (input.suite as Record<string, unknown>).id = 'Not Portable';
      },
      '$.suite.id',
    ],
    [
      'duplicate case id',
      (input: Record<string, unknown>): void => {
        recordAt(input.cases, 1).id = 'polluter';
      },
      'case IDs must be unique',
    ],
    [
      'duplicate state root id',
      (input: Record<string, unknown>): void => {
        recordAt(input.stateRoots, 1).id = 'workspace';
      },
      'state-root IDs must be unique',
    ],
    [
      'missing cwd root',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as { run: Record<string, unknown> };
        adapter.run.cwd = { base: 'state', root: 'missing', path: '.' };
      },
      'references unknown state root',
    ],
    [
      'forbidden env',
      (input: Record<string, unknown>): void => {
        input.environment = { set: { NODE_OPTIONS: '--inspect' } };
      },
      'forbidden environment variable',
    ],
    [
      'too few cases',
      (input: Record<string, unknown>): void => {
        input.cases = (input.cases as unknown[]).slice(0, 1);
      },
      'between 2 and 256',
    ],
    [
      'invalid program lookup',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as { run: Record<string, unknown> };
        adapter.run.program = { lookup: '../bin/tool' };
      },
      'bare executable name',
    ],
    [
      'invalid oracle',
      (input: Record<string, unknown>): void => {
        const adapter = input.adapter as Record<string, unknown>;
        adapter.oracle = { kind: 'all', rules: [] };
      },
      'rules must contain between 1 and 64',
    ],
  ])('rejects %s', (_label, mutate, message) => {
    const input = minimalManifest();
    mutate(input);

    expect(() => parseManifest(input)).toThrow(message);
  });

  it('allows explicit inheritance of AI provider credential names', () => {
    const input = minimalManifest();
    input.environment = {
      inherit: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    };

    expect(parseManifest(input).environment.inherit).toEqual([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it.each([
    ['stepTimeoutMs', MANIFEST_HARD_LIMITS.maxCommandTimeoutMs + 1],
    ['caseTimeoutMs', MANIFEST_HARD_LIMITS.maxCaseTimeoutMs + 1],
    ['armTimeoutMs', MANIFEST_HARD_LIMITS.maxArmTimeoutMs + 1],
    ['suiteTimeoutMs', MANIFEST_HARD_LIMITS.maxSuiteTimeoutMs + 1],
    ['cleanupTimeoutMs', MANIFEST_HARD_LIMITS.maxCleanupTimeoutMs + 1],
    ['maxStdoutBytes', MANIFEST_HARD_LIMITS.maxStdoutBytes + 1],
    ['maxStderrBytes', MANIFEST_HARD_LIMITS.maxStderrBytes + 1],
    ['maxStdinBytes', MANIFEST_HARD_LIMITS.maxStdinBytes + 1],
    ['maxSnapshotEntries', MANIFEST_HARD_LIMITS.maxSnapshotEntries + 1],
    ['maxSnapshotFileBytes', MANIFEST_HARD_LIMITS.maxSnapshotFileBytes + 1],
    ['maxSnapshotBytes', MANIFEST_HARD_LIMITS.maxSnapshotBytes + 1],
  ])('enforces the hard execution limit for %s', (field, value) => {
    const input = minimalManifest();
    input.execution = { [field]: value };

    expect(() => parseManifest(input)).toThrow(
      new RegExp(`\\$\\.execution\\.${field} must be an integer between`, 'u'),
    );
  });

  it('enforces timeout ordering, snapshot byte ordering, and command timeout caps', () => {
    const timeoutOrder = minimalManifest();
    timeoutOrder.execution = { stepTimeoutMs: 61_000 };
    const snapshotOrder = minimalManifest();
    snapshotOrder.execution = {
      maxSnapshotBytes: 1024,
      maxSnapshotFileBytes: 2048,
    };
    const commandTimeout = minimalManifest();
    commandTimeout.execution = { stepTimeoutMs: 5_000 };
    (commandTimeout.adapter as { run: Record<string, unknown> }).run.timeoutMs = 5_001;

    expect(() => parseManifest(timeoutOrder)).toThrow('timeouts must satisfy');
    expect(() => parseManifest(snapshotOrder)).toThrow('maxSnapshotFileBytes must not exceed');
    expect(() => parseManifest(commandTimeout)).toThrow(
      '$.adapter.run.timeoutMs must be an integer between',
    );
  });

  it('rejects case-folded environment collisions and loader injection inheritance', () => {
    const collision = minimalManifest();
    collision.environment = {
      set: { MODE: 'one' },
      unset: ['mode'],
    };
    const injection = minimalManifest();
    injection.environment = {
      inherit: ['LD_PRELOAD'],
    };

    expect(() => parseManifest(collision)).toThrow(
      'must not inherit, set, or unset the same environment name',
    );
    expect(() => parseManifest(injection)).toThrow('forbidden environment variable');
  });

  it('accepts portable non-Node executable lookups and rejects command-script shims', () => {
    const portable = minimalManifest();
    (portable.adapter as { run: Record<string, unknown> }).run.program = {
      lookup: 'agent-runner',
    };
    const scriptShim = minimalManifest();
    (scriptShim.adapter as { run: Record<string, unknown> }).run.program = {
      lookup: 'agent.cmd',
    };

    expect(parseManifest(portable).adapter.run.program).toEqual({
      lookup: 'agent-runner',
    });
    expect(() => parseManifest(scriptShim)).toThrow('bare executable name');
  });
});

function recordAt(value: unknown, index: number): Record<string, unknown> {
  if (!Array.isArray(value)) {
    throw new Error('The test fixture field must be an array.');
  }
  const entry: unknown = value[index];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('The test fixture array entry must be an object.');
  }
  return entry as Record<string, unknown>;
}

describe('loadManifest', () => {
  it('loads a stable regular file, hashes its exact bytes, and canonicalizes suite paths', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, 'nested', 'suite.json');
    const input = minimalManifest();
    const source = `${JSON.stringify(input, null, 2)}\n`;
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, source, 'utf8');

    const loaded = await loadManifest(sourcePath);
    const canonicalSourcePath = await realpath(sourcePath);
    const canonicalSuiteDir = dirname(canonicalSourcePath);

    expect(loaded).toMatchObject({
      sourcePath: canonicalSourcePath,
      sourceSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
      suiteDir: canonicalSuiteDir,
      stateRoots: [
        {
          id: 'workspace',
          seed: {
            kind: 'copy',
            path: 'fixtures/workspace',
            resolvedPath: resolve(canonicalSuiteDir, 'fixtures', 'workspace'),
          },
        },
        {
          id: 'memory',
          seed: { kind: 'empty' },
        },
      ],
    });
  });

  it('rejects duplicate keys, invalid UTF-8, BOM, oversized files, directories, and links', async () => {
    const directory = await temporaryDirectory();
    const duplicate = join(directory, 'duplicate.json');
    const invalidUtf8 = join(directory, 'invalid.json');
    const bom = join(directory, 'bom.json');
    const oversized = join(directory, 'oversized.json');
    const target = join(directory, 'target.json');
    const linked = join(directory, 'linked.json');
    await writeFile(duplicate, '{"schema":"ghostcase/suite/v1","schema":"other"}');
    await writeFile(invalidUtf8, Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]));
    await writeFile(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    await writeFile(oversized, Buffer.alloc(MANIFEST_FILE_MAX_BYTES + 1, 0x20));
    await writeFile(target, JSON.stringify(minimalManifest()));
    let linkedCreated = true;
    try {
      await symlink(target, linked, 'file');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        linkedCreated = false;
      } else {
        throw error;
      }
    }

    await expect(loadManifest(duplicate)).rejects.toThrow('duplicate object key');
    await expect(loadManifest(invalidUtf8)).rejects.toThrow('UTF-8');
    await expect(loadManifest(bom)).rejects.toThrow('BOM');
    await expect(loadManifest(oversized)).rejects.toThrow('byte limit');
    await expect(loadManifest(directory)).rejects.toThrow('regular non-link file');
    if (linkedCreated) {
      await expect(loadManifest(linked)).rejects.toThrow('regular non-link file');
    }
  });

  it('does not require seed or executable paths to exist while parsing configuration', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, 'suite.json');
    const input = minimalManifest();
    const adapter = input.adapter as { run: Record<string, unknown> };
    adapter.run.program = { path: 'missing/tool.exe' };
    await writeFile(sourcePath, JSON.stringify(input));

    await expect(loadManifest(sourcePath)).resolves.toMatchObject({
      definition: {
        adapter: {
          run: { program: { path: 'missing/tool.exe' } },
        },
      },
      stateRoots: [
        {
          seed: {
            kind: 'copy',
            resolvedPath: resolve(directory, 'fixtures', 'workspace'),
          },
        },
        { seed: { kind: 'empty' } },
      ],
    });
  });
});
