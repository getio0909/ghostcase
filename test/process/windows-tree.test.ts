import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cleanupExitedWindowsDescendants } from '../../src/process/windows-tree.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;

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

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || !processExists(child.pid)) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Test child did not close after SIGKILL.'));
    }, 2_000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  child.kill('SIGKILL');
  await closed;
}

async function runShortLivedCleanupHost(): Promise<{
  readonly durationMilliseconds: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'process', 'windows-tree.ts')).href;
  const source = [
    `import { cleanupExitedWindowsDescendants } from ${JSON.stringify(moduleUrl)};`,
    'const now = Date.now();',
    'const result = await cleanupExitedWindowsDescendants(4294967294, now - 100, now);',
    'process.stdout.write(JSON.stringify(result));',
  ].join('');
  const beganAt = performance.now();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  return await new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Short-lived cleanup host did not exit after its helper became idle.'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `Short-lived cleanup host failed (${code === null ? (signal ?? 'unknown') : String(code)}): ${stderr}`,
          ),
        );
        return;
      }
      resolve({
        durationMilliseconds: performance.now() - beganAt,
        stderr,
        stdout,
      });
    });
  });
}

describe('cleanupExitedWindowsDescendants', () => {
  windowsIt(
    'returns none without turning a normal no-descendant exit into a cleanup failure',
    async () => {
      const closedAt = Date.now();
      const startedAt = closedAt - 100;
      const beganAt = performance.now();

      const result = await cleanupExitedWindowsDescendants(4_294_967_294, startedAt, closedAt);

      expect(result).toEqual({ kind: 'none' });
      expect(performance.now() - beganAt).toBeLessThan(11_000);
    },
    15_000,
  );

  windowsIt(
    'excludes the helper itself and a later process from the captured root lifetime',
    async () => {
      const warmedAt = Date.now();
      expect(
        await cleanupExitedWindowsDescendants(4_294_967_294, warmedAt - 100, warmedAt),
      ).toEqual({ kind: 'none' });

      const startedAt = 0;
      const closedAt = Date.now();
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      try {
        const result = await cleanupExitedWindowsDescendants(process.pid, startedAt, closedAt);

        expect(result).toEqual({ kind: 'none' });
        expect(child.pid).toBeDefined();
        expect(processExists(child.pid ?? 0)).toBe(true);
      } finally {
        await stopProcess(child);
      }
    },
    15_000,
  );

  windowsIt(
    'handles concurrent requests without mismatching responses',
    async () => {
      const closedAt = Date.now();
      const results = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          return await cleanupExitedWindowsDescendants(
            4_294_967_000 + index,
            closedAt - 100,
            closedAt,
          );
        }),
      );

      expect(results).toEqual(Array.from({ length: 16 }, () => ({ kind: 'none' })));
    },
    15_000,
  );

  windowsIt(
    'rejects invalid inputs without poisoning the shared helper',
    async () => {
      const closedAt = Date.now();

      const failures = await Promise.all([
        cleanupExitedWindowsDescendants(0, closedAt - 100, closedAt),
        cleanupExitedWindowsDescendants(4_294_967_296, closedAt - 100, closedAt),
        cleanupExitedWindowsDescendants(1.5, closedAt - 100, closedAt),
        cleanupExitedWindowsDescendants(1, Number.NaN, closedAt),
        cleanupExitedWindowsDescendants(1, closedAt, closedAt - 1),
      ]);
      const recovery = await cleanupExitedWindowsDescendants(
        4_294_967_294,
        closedAt - 100,
        closedAt,
      );

      expect(failures.every((failure) => failure.kind === 'failed')).toBe(true);
      expect(recovery).toEqual({ kind: 'none' });
    },
    15_000,
  );

  windowsIt(
    'does not traverse an out-of-window intermediate process to an in-window leaf',
    async () => {
      const intermediateSource = [
        "const { spawn } = require('node:child_process');",
        "process.once('message', () => {",
        "const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
        'leaf.unref();',
        'process.send?.(leaf.pid);',
        '});',
        'setInterval(() => {}, 1_000);',
      ].join('');
      const intermediate = spawn(process.execPath, ['-e', intermediateSource], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        intermediate.once('spawn', resolve);
        intermediate.once('error', reject);
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 75);
      });

      let leafProcessId: number | undefined;
      try {
        const startedAt = Date.now();
        const leaf = new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Intermediate process did not report its leaf process id.'));
          }, 2_000);
          intermediate.once('message', (message: unknown) => {
            clearTimeout(timeout);
            if (typeof message !== 'number' || !Number.isSafeInteger(message) || message <= 0) {
              reject(new Error('Intermediate process reported an invalid leaf process id.'));
              return;
            }
            resolve(message);
          });
        });
        intermediate.send('spawn');
        leafProcessId = await leaf;
        const closedAt = Date.now();

        const result = await cleanupExitedWindowsDescendants(process.pid, startedAt, closedAt);

        expect(result).toEqual({ kind: 'none' });
        expect(processExists(leafProcessId)).toBe(true);
      } finally {
        if (leafProcessId !== undefined && processExists(leafProcessId)) {
          process.kill(leafProcessId, 'SIGKILL');
        }
        await stopProcess(intermediate);
      }
    },
    15_000,
  );

  windowsIt(
    'keeps hot cleanup latency bounded',
    async () => {
      const sampleCount = 20;
      const durations: number[] = [];
      const warmedAt = Date.now();
      expect(
        await cleanupExitedWindowsDescendants(4_294_967_294, warmedAt - 100, warmedAt),
      ).toEqual({ kind: 'none' });

      for (let index = 0; index < sampleCount; index += 1) {
        const closedAt = Date.now();
        const beganAt = performance.now();
        const result = await cleanupExitedWindowsDescendants(
          4_294_967_294,
          closedAt - 100,
          closedAt,
        );
        durations.push(performance.now() - beganAt);
        expect(result).toEqual({ kind: 'none' });
      }

      durations.sort((left, right) => left - right);
      const percentile95 = durations[Math.ceil(sampleCount * 0.95) - 1];
      expect(percentile95).toBeDefined();
      expect(percentile95 ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
    },
    20_000,
  );

  windowsIt(
    'allows a short-lived Node host to exit after the helper becomes idle',
    async () => {
      const result = await runShortLivedCleanupHost();

      expect(result.stdout).toBe('{"kind":"none"}');
      expect(result.stderr).toBe('');
      expect(result.durationMilliseconds).toBeLessThan(15_000);
    },
    20_000,
  );
});
