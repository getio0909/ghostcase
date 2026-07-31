import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommand, type RunCommandResult } from '../../src/process/index.js';

const temporaryDirectories: string[] = [];
const windowsIt = process.platform === 'win32' ? it : it.skip;

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-process-'));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nodeCommand(source: string): readonly string[] {
  return [process.execPath, '-e', source];
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(processId)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !processExists(processId);
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('runCommand', () => {
  it('captures exit metadata and bounded stdout and stderr evidence', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand(
        "process.stdout.write('hello'); process.stderr.write('warning'); process.exitCode = 7;",
      ),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      captureLimitBytes: 128,
    });

    expect(result).toEqual({
      status: 'exited',
      exitCode: 7,
      signal: null,
      durationMs: result.durationMs,
      outputLimitStream: null,
      reason: null,
      stdout: {
        bytes: 5,
        sha256: digest('hello'),
        content: 'hello',
        truncated: false,
      },
      stderr: {
        bytes: 7,
        sha256: digest('warning'),
        content: 'warning',
        truncated: false,
      },
      termination: {
        status: 'not_needed',
        escalated: false,
        detail: null,
      },
    });
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  windowsIt(
    'does not misclassify naturally retiring Windows console hosts as leaked descendants',
    async () => {
      const cwd = await makeTemporaryDirectory();

      for (let index = 0; index < 24; index += 1) {
        const result = await runCommand({
          argv: nodeCommand("process.stdout.write('ok')"),
          cwd,
          env: {},
          stdin: null,
          timeoutMs: 2_000,
          stdoutLimitBytes: 16,
          stderrLimitBytes: 16,
          captureLimitBytes: 16,
        });

        expect(result.status).toBe('exited');
        expect(
          result.termination.status,
          result.termination.detail ?? `Iteration ${String(index)} unexpectedly required cleanup.`,
        ).toBe('not_needed');
      }
    },
    20_000,
  );

  it('counts raw bytes and truncates captured content without truncating its digest', async () => {
    const cwd = await makeTemporaryDirectory();
    const output = '\u00e9\u00e9\u00e9';

    const result = await runCommand({
      argv: nodeCommand(`process.stdout.write(${JSON.stringify(output)})`),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 4,
    });

    expect(result.stdout).toEqual({
      bytes: 6,
      sha256: digest(output),
      content: '\u00e9\u00e9',
      truncated: true,
    });
  });

  it('does not emit a replacement character beyond a split UTF-8 capture boundary', async () => {
    const cwd = await makeTemporaryDirectory();
    const output = '\u00e9';

    const result = await runCommand({
      argv: nodeCommand(`process.stdout.write(${JSON.stringify(output)})`),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 1,
    });

    expect(result.stdout).toEqual({
      bytes: 2,
      sha256: digest(output),
      content: '',
      truncated: true,
    });
    expect(Buffer.byteLength(result.stdout.content)).toBeLessThanOrEqual(1);
  });

  it('preserves an empty string as a legitimate argv value', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        '',
      ],
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });

    expect(result.status).toBe('exited');
    expect(result.stdout.content).toBe('[""]');
  });

  it('pipes and ends an empty stdin buffer without hanging', async () => {
    const cwd = await makeTemporaryDirectory();
    const source = [
      'const chunks = [];',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => process.stdout.write(String(Buffer.concat(chunks).byteLength)));",
    ].join('');

    const result = await runCommand({
      argv: nodeCommand(source),
      cwd,
      env: {},
      stdin: Buffer.alloc(0),
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.content).toBe('0');
  });

  it('clones and preserves binary stdin bytes', async () => {
    const cwd = await makeTemporaryDirectory();
    const source = [
      'const chunks = [];',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('hex')));",
    ].join('');
    const input = Buffer.from([0x00, 0xff, 0x01, 0x80, 0x7f]);

    const pendingResult = runCommand({
      argv: nodeCommand(source),
      cwd,
      env: {},
      stdin: input,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });
    input.fill(0x2a);
    const result = await pendingResult;

    expect(result.status).toBe('exited');
    expect(result.stdout.content).toBe('00ff01807f');
  });

  it('allows a platform broken-pipe error when a child exits successfully', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand('process.stdin.destroy(); process.exit(0)'),
      cwd,
      env: {},
      stdin: Buffer.alloc(4 * 1_024 * 1_024, 0x61),
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });

    expect(result.status, result.reason ?? 'Command exited without a reason.').toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBeNull();
  });

  it('reports a broken stdin pipe when the child exit is not successful', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand('process.stdin.destroy(); process.exit(7)'),
      cwd,
      env: {},
      stdin: Buffer.alloc(4 * 1_024 * 1_024, 0x61),
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });

    expect(result.status).toBe('spawn_error');
    expect(result.exitCode).toBe(7);
    expect(result.reason).toMatch(
      /^Command stdin closed before input was accepted \((?:EPIPE|EOF|ECONNRESET)\)\.$/u,
    );
    expect(
      result.termination.status,
      result.termination.detail ?? 'No descendant cleanup was required.',
    ).toBe('not_needed');
  });

  it('rejects non-buffer stdin without exposing its value', async () => {
    const cwd = await makeTemporaryDirectory();
    const invalidInput = 'private-stdin-value';

    const pendingResult = runCommand({
      argv: nodeCommand('void 0'),
      cwd,
      env: {},
      stdin: invalidInput as unknown as Buffer,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 64,
      captureLimitBytes: 64,
    });

    await expect(pendingResult).rejects.toThrow(TypeError);
    await expect(pendingResult).rejects.not.toThrow(invalidInput);
  });

  it('uses only the explicit cwd and environment supplied by the caller', async () => {
    const cwd = await makeTemporaryDirectory();
    const previousUnlistedValue = process.env.GHOSTCASE_UNLISTED;
    process.env.GHOSTCASE_UNLISTED = 'host-only';

    let result: RunCommandResult;
    try {
      result = await runCommand({
        argv: nodeCommand(
          'process.stdout.write(JSON.stringify({ cwd: process.cwd(), explicit: process.env.GHOSTCASE_EXPLICIT ?? null, inherited: process.env.GHOSTCASE_UNLISTED ?? null }))',
        ),
        cwd,
        env: { GHOSTCASE_EXPLICIT: 'present' },
        stdin: null,
        timeoutMs: 2_000,
        stdoutLimitBytes: 1_024,
        stderrLimitBytes: 1_024,
        captureLimitBytes: 1_024,
      });
    } finally {
      if (previousUnlistedValue === undefined) {
        delete process.env.GHOSTCASE_UNLISTED;
      } else {
        process.env.GHOSTCASE_UNLISTED = previousUnlistedValue;
      }
    }

    expect(JSON.parse(result.stdout.content)).toEqual({
      cwd,
      explicit: 'present',
      inherited: null,
    });
  });

  it('returns a redacted spawn error without exposing cwd or environment values', async () => {
    const cwd = await makeTemporaryDirectory();
    const secret = 'do-not-leak-this-value';

    const result = await runCommand({
      argv: [join(cwd, 'executable-that-does-not-exist')],
      cwd,
      env: { GHOSTCASE_SECRET: secret },
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      captureLimitBytes: 128,
    });

    expect(result.status).toBe('spawn_error');
    expect(result.reason).toMatch(/^Command could not be started \([A-Z0-9_]+\)\.$/u);
    expect(result.reason).not.toContain(cwd);
    expect(result.reason).not.toContain(secret);
    expect(result.termination.status).toBe('not_needed');
  });

  it.each([
    { name: 'an empty argv', argv: [] },
    { name: 'an empty executable', argv: ['', '--version'] },
    { name: 'a NUL in the executable', argv: [`bad\u0000command`] },
    { name: 'a NUL in an argument', argv: [process.execPath, `bad\u0000argument`] },
  ])('rejects $name before spawning', async ({ argv }) => {
    const cwd = await makeTemporaryDirectory();

    await expect(
      runCommand({
        argv,
        cwd,
        env: {},
        stdin: null,
        timeoutMs: 2_000,
        stdoutLimitBytes: 128,
        stderrLimitBytes: 128,
        captureLimitBytes: 128,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('rejects a capture bound larger than either stream bound', async () => {
    const cwd = await makeTemporaryDirectory();

    await expect(
      runCommand({
        argv: nodeCommand('void 0'),
        cwd,
        env: {},
        stdin: null,
        timeoutMs: 2_000,
        stdoutLimitBytes: 32,
        stderrLimitBytes: 16,
        captureLimitBytes: 17,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('terminates and settles a command that exceeds its timeout', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand('setInterval(() => {}, 1_000)'),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 50,
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      captureLimitBytes: 128,
    });

    expect(result.status).toBe('timed_out');
    expect(result.reason).toBe('Command exceeded its 50 ms timeout.');
    expect(
      result.termination.status,
      result.termination.detail ?? 'Process-tree termination was not confirmed.',
    ).toBe('confirmed');
    expect(result.durationMs).toBeLessThan(6_000);
  }, 8_000);

  it('terminates the process tree so a grandchild cannot outlive the timeout', async () => {
    const cwd = await makeTemporaryDirectory();
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1_000);',
    ].join('');

    let grandchildProcessId: number | undefined;
    try {
      const result = await runCommand({
        argv: nodeCommand(parentSource),
        cwd,
        env: {},
        stdin: null,
        timeoutMs: 500,
        stdoutLimitBytes: 128,
        stderrLimitBytes: 128,
        captureLimitBytes: 128,
      });
      grandchildProcessId = Number.parseInt(result.stdout.content, 10);

      expect(result.status).toBe('timed_out');
      expect(Number.isSafeInteger(grandchildProcessId)).toBe(true);
      expect(
        result.termination.status,
        result.termination.detail ?? 'Process-tree termination was not confirmed.',
      ).toBe('confirmed');
      expect(processExists(grandchildProcessId)).toBe(false);
    } finally {
      if (
        grandchildProcessId !== undefined &&
        Number.isSafeInteger(grandchildProcessId) &&
        grandchildProcessId > 0 &&
        processExists(grandchildProcessId)
      ) {
        process.kill(grandchildProcessId, 'SIGKILL');
      }
    }
  }, 10_000);

  it('removes a long-lived descendant after its parent exits successfully', async () => {
    const cwd = await makeTemporaryDirectory();
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true });",
      'child.unref();',
      'process.stdout.write(String(child.pid));',
    ].join('');

    let descendantProcessId: number | undefined;
    try {
      const result = await runCommand({
        argv: nodeCommand(parentSource),
        cwd,
        env: {},
        stdin: null,
        timeoutMs: 5_000,
        stdoutLimitBytes: 128,
        stderrLimitBytes: 128,
        captureLimitBytes: 128,
      });
      descendantProcessId = Number.parseInt(result.stdout.content, 10);

      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(descendantProcessId)).toBe(true);
      expect(
        result.termination.status,
        result.termination.detail ?? 'Descendant cleanup was not confirmed.',
      ).toBe('confirmed');
      expect(await waitForProcessExit(descendantProcessId, 2_000)).toBe(true);
    } finally {
      if (
        descendantProcessId !== undefined &&
        Number.isSafeInteger(descendantProcessId) &&
        descendantProcessId > 0 &&
        processExists(descendantProcessId)
      ) {
        process.kill(descendantProcessId, 'SIGKILL');
      }
    }
  }, 20_000);

  it('marks stdout overflow and preserves only the configured capture bytes', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand("process.stdout.write('x'.repeat(4_096)); setInterval(() => {}, 1_000)"),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 32,
      stderrLimitBytes: 64,
      captureLimitBytes: 8,
    });

    expect(result.status).toBe('output_limit');
    expect(result.outputLimitStream).toBe('stdout');
    expect(result.stdout.bytes).toBeGreaterThan(32);
    expect(Buffer.byteLength(result.stdout.content)).toBe(8);
    expect(result.stdout.content).toBe('xxxxxxxx');
    expect(result.stdout.truncated).toBe(true);
    expect(result.termination.status).toBe('confirmed');
  }, 8_000);

  it('enforces stderr limits independently from stdout limits', async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runCommand({
      argv: nodeCommand("process.stderr.write('y'.repeat(4_096)); setInterval(() => {}, 1_000)"),
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 32,
      captureLimitBytes: 8,
    });

    expect(result.status).toBe('output_limit');
    expect(result.outputLimitStream).toBe('stderr');
    expect(result.stderr.bytes).toBeGreaterThan(32);
    expect(Buffer.byteLength(result.stderr.content)).toBe(8);
    expect(result.termination.status).toBe('confirmed');
  }, 8_000);

  it('supports aborting a running command', async () => {
    const cwd = await makeTemporaryDirectory();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, 50);

    try {
      const result = await runCommand({
        argv: nodeCommand('setInterval(() => {}, 1_000)'),
        cwd,
        env: {},
        stdin: null,
        timeoutMs: 2_000,
        stdoutLimitBytes: 128,
        stderrLimitBytes: 128,
        captureLimitBytes: 128,
        signal: controller.signal,
      });

      expect(result.status).toBe('aborted');
      expect(result.reason).toBe('Command execution was aborted.');
      expect(result.termination.status).toBe('confirmed');
      expect(result.exitCode !== null || result.signal !== null).toBe(true);
      expect(result.durationMs).toBeLessThan(6_000);
    } finally {
      clearTimeout(abortTimer);
    }
  }, 8_000);

  it('does not spawn when the abort signal is already set', async () => {
    const cwd = await makeTemporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    const result = await runCommand({
      argv: [join(cwd, 'this-executable-must-not-be-opened')],
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      captureLimitBytes: 128,
      signal: controller.signal,
    });

    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('Command execution was aborted before start.');
    expect(result.termination).toEqual({
      status: 'not_needed',
      escalated: false,
      detail: null,
    });

    const secondResult = await runCommand({
      argv: [join(cwd, 'this-executable-must-not-be-opened-either')],
      cwd,
      env: {},
      stdin: null,
      timeoutMs: 2_000,
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      captureLimitBytes: 128,
      signal: controller.signal,
    });
    expect(secondResult.termination).not.toBe(result.termination);
  });
});
