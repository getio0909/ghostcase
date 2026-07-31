import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parsePortablePath } from '../../src/config/portable-path.js';
import { ConfigError, HarnessError } from '../../src/domain/errors.js';
import type { CommandSpec, EnvironmentSpec, RunPatch, ValueSpec } from '../../src/domain/model.js';
import {
  mergeRunCommand,
  resolveCommand,
  resolvePathReference,
  validateCommandMetadata,
  type CommandResolutionContext,
} from '../../src/runtime/resolve-command.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<{
  context: CommandResolutionContext;
  environment: EnvironmentSpec;
}> {
  const armRoot = await temporaryDirectory();
  const suiteDir = await temporaryDirectory();
  const workspace = join(armRoot, 'state', 'workspace');
  const tempRoot = join(armRoot, 'temp');
  await mkdir(workspace, { recursive: true });
  await mkdir(tempRoot);
  return {
    context: {
      armRoot,
      hostEnvironment: {
        API_TOKEN: 'sentinel-token',
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      },
      maxStdinBytes: 1024,
      stateRoots: new Map([['workspace', workspace]]),
      suiteDir,
      tempRoot,
    },
    environment: {
      inherit: [],
      set: { CI: '1' },
      unset: [],
    },
  };
}

function command(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    argv: [],
    cwd: {
      base: 'state',
      path: parsePortablePath('.', '$.cwd.path'),
      root: 'workspace',
    },
    env: { set: {}, unset: [] },
    program: { lookup: 'node' },
    stdin: { kind: 'none' },
    timeoutMs: 10_000,
    ...overrides,
  };
}

function workspaceRoot(context: CommandResolutionContext): string {
  const root = context.stateRoots.get('workspace');
  if (root === undefined) {
    throw new Error('test fixture is missing the workspace state root');
  }
  return root;
}

describe('resolveCommand', () => {
  it('resolves node, state paths, cwd, and isolated runtime environment', async () => {
    const { context, environment } = await fixture();
    const pathValue: ValueSpec = {
      path: {
        base: 'state',
        path: parsePortablePath('result.json', '$.argv.path'),
        root: 'workspace',
      },
    };

    const resolved = await resolveCommand(
      command({
        argv: ['agent.mjs', pathValue],
        env: { set: { RESULT_PATH: pathValue }, unset: [] },
      }),
      environment,
      context,
    );

    expect(resolved.argv).toEqual([
      expect.stringContaining('node'),
      'agent.mjs',
      join(workspaceRoot(context), 'result.json'),
    ]);
    expect(resolved.cwd).toBe(context.stateRoots.get('workspace'));
    expect(resolved.env).toMatchObject({
      CI: '1',
      GHOSTCASE: '1',
      HOME: context.tempRoot,
      RESULT_PATH: join(workspaceRoot(context), 'result.json'),
      TEMP: context.tempRoot,
      TMP: context.tempRoot,
    });
    expect(resolved.env.API_TOKEN).toBeUndefined();
    expect(resolved.stdin).toBeNull();
  });

  it('inherits only explicitly named host environment values', async () => {
    const { context, environment } = await fixture();
    const resolved = await resolveCommand(
      command(),
      { ...environment, inherit: ['API_TOKEN'] },
      context,
    );
    expect(resolved.env.API_TOKEN).toBe('sentinel-token');

    await expect(
      resolveCommand(command(), { ...environment, inherit: ['MISSING_VALUE'] }, context),
    ).rejects.toThrow('explicitly inherited');
  });

  it('applies command unset/set after suite environment without case-fold duplicates', async () => {
    const { context } = await fixture();
    const resolved = await resolveCommand(
      command({
        env: {
          set: { MODE: 'command' },
          unset: ['REMOVE_ME'],
        },
      }),
      {
        inherit: [],
        set: { MODE: 'suite', REMOVE_ME: 'yes' },
        unset: [],
      },
      context,
    );

    expect(resolved.env.MODE).toBe('command');
    expect(resolved.env.REMOVE_ME).toBeUndefined();
  });

  it('resolves bounded text and file stdin without following a linked file', async () => {
    const { context, environment } = await fixture();
    const workspace = workspaceRoot(context);
    await writeFile(join(workspace, 'input.bin'), Buffer.from([0, 1, 2, 3]));

    const fromFile = await resolveCommand(
      command({
        stdin: {
          kind: 'file',
          path: {
            path: {
              base: 'state',
              path: parsePortablePath('input.bin', '$.stdin.path'),
              root: 'workspace',
            },
          },
        },
      }),
      environment,
      context,
    );
    expect(fromFile.stdin).toEqual(Buffer.from([0, 1, 2, 3]));

    const fromText = await resolveCommand(
      command({ stdin: { kind: 'text', value: 'hello' } }),
      environment,
      context,
    );
    expect(fromText.stdin?.toString('utf8')).toBe('hello');

    const external = join(context.suiteDir, 'external.bin');
    await writeFile(external, 'secret', 'utf8');
    const linked = join(workspace, 'linked.bin');
    try {
      await symlink(external, linked, 'file');
      await expect(
        resolveCommand(
          command({
            stdin: {
              kind: 'file',
              path: {
                path: {
                  base: 'state',
                  path: parsePortablePath('linked.bin', '$.stdin.path'),
                  root: 'workspace',
                },
              },
            },
          }),
          environment,
          context,
        ),
      ).rejects.toThrow('A command stdin file is not a permitted regular non-link file.');
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !(error instanceof Error && 'code' in error && error.code === 'EPERM')
      ) {
        throw error;
      }
    }
  });

  it('validates file stdin metadata without opening or reading the file', async () => {
    const { context, environment } = await fixture();
    const input = join(context.suiteDir, 'metadata-only.bin');
    await writeFile(input, 'metadata-only-content', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(input, 0);
    }

    await expect(
      validateCommandMetadata(
        command({
          stdin: {
            kind: 'file',
            path: {
              path: {
                base: 'suite',
                path: parsePortablePath('metadata-only.bin', '$.stdin.path'),
              },
            },
          },
        }),
        environment,
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts file and UTF-8 text stdin exactly at the metadata byte limit', async () => {
    const { context, environment } = await fixture();
    await writeFile(join(context.suiteDir, 'exact.bin'), Buffer.alloc(4, 0x61));
    const limitedContext = { ...context, maxStdinBytes: 4 };

    await expect(
      validateCommandMetadata(
        command({
          stdin: {
            kind: 'file',
            path: {
              path: {
                base: 'suite',
                path: parsePortablePath('exact.bin', '$.stdin.path'),
              },
            },
          },
        }),
        environment,
        limitedContext,
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateCommandMetadata(
        command({ stdin: { kind: 'text', value: '界a' } }),
        environment,
        limitedContext,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects stdin that escapes the typed-path root in metadata and runtime resolution', async () => {
    const { context, environment } = await fixture();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'private.bin'), 'private', 'utf8');
    await symlink(
      outside,
      join(context.suiteDir, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const escaped = command({
      stdin: {
        kind: 'file',
        path: {
          path: {
            base: 'suite',
            path: parsePortablePath('escape/private.bin', '$.stdin.path'),
          },
        },
      },
    });

    await expect(validateCommandMetadata(escaped, environment, context)).rejects.toThrow('escaped');
    await expect(resolveCommand(escaped, environment, context)).rejects.toThrow('escaped');
  });

  it('rejects stdin larger than the configured maximum', async () => {
    const { context, environment } = await fixture();
    await expect(
      resolveCommand(command({ stdin: { kind: 'text', value: 'too large' } }), environment, {
        ...context,
        maxStdinBytes: 3,
      }),
    ).rejects.toThrow('byte limit');
  });

  it('resolves an explicit suite executable and rejects a suite executable link', async () => {
    const { context, environment } = await fixture();
    const executableName = process.platform === 'win32' ? 'runner.exe' : 'runner';
    const executable = join(context.suiteDir, executableName);
    await writeFile(executable, 'binary placeholder', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(executable, 0o700);
    }
    await expect(
      resolveCommand(
        command({ program: { path: parsePortablePath(executableName, '$.program.path') } }),
        environment,
        context,
      ),
    ).resolves.toMatchObject({ argv: [executable] });

    const linkedName = process.platform === 'win32' ? 'linked.exe' : 'linked';
    try {
      await symlink(executable, join(context.suiteDir, linkedName), 'file');
      await expect(
        resolveCommand(
          command({ program: { path: parsePortablePath(linkedName, '$.program.path') } }),
          environment,
          context,
        ),
      ).rejects.toThrow('permitted regular file');
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !(error instanceof Error && 'code' in error && error.code === 'EPERM')
      ) {
        throw error;
      }
    }
  });

  it('rejects unknown state roots and temp references that name a root', async () => {
    const { context } = await fixture();
    expect(() =>
      resolvePathReference(
        {
          base: 'state',
          path: parsePortablePath('.', '$.path'),
          root: 'missing',
        },
        context,
      ),
    ).toThrow(ConfigError);
    expect(() =>
      resolvePathReference(
        {
          base: 'temp',
          path: parsePortablePath('.', '$.path'),
          root: 'workspace',
        },
        context,
      ),
    ).toThrow(ConfigError);
  });

  it('rejects a working directory reached through a junction or directory link', async () => {
    const { context, environment } = await fixture();
    const workspace = workspaceRoot(context);
    const external = await temporaryDirectory();
    const linked = join(workspace, 'linked');
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      resolveCommand(
        command({
          cwd: {
            base: 'state',
            path: parsePortablePath('linked', '$.cwd.path'),
            root: 'workspace',
          },
        }),
        environment,
        context,
      ),
    ).rejects.toThrow(HarnessError);
  });
});

describe('mergeRunCommand', () => {
  it('appends argv and applies case overrides without changing the base', () => {
    const base = command({
      argv: ['base'],
      env: { set: { BASE: '1', REMOVE: '1' }, unset: ['OLD'] },
    });
    const patch: RunPatch = {
      argv: ['case'],
      env: { set: { CASE: '1', OLD: 'restored' }, unset: ['REMOVE'] },
      timeoutMs: 500,
    };

    const merged = mergeRunCommand(base, patch);

    expect(merged).toMatchObject({
      argv: ['base', 'case'],
      env: {
        set: { BASE: '1', CASE: '1', OLD: 'restored' },
        unset: ['REMOVE'],
      },
      timeoutMs: 500,
    });
    expect(base.argv).toEqual(['base']);
    expect(base.env.set).toEqual({ BASE: '1', REMOVE: '1' });
  });
});
