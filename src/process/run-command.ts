import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { cleanupExitedWindowsDescendants, warmWindowsTreeHelper } from './windows-tree.js';

const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const GRACEFUL_TERMINATION_MILLISECONDS = 150;
const FORCED_TERMINATION_MILLISECONDS = 250;
const CLOSE_DRAIN_MILLISECONDS = 500;
const WINDOWS_TERMINATOR_TIMEOUT_MILLISECONDS = 5_000;
const EMPTY_SHA256 = createHash('sha256').digest('hex');

export type CommandStatus = 'exited' | 'timed_out' | 'output_limit' | 'aborted' | 'spawn_error';

export type OutputStreamName = 'stdout' | 'stderr';

export interface RunCommandOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Buffer | null;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly captureLimitBytes: number;
  readonly signal?: AbortSignal;
}

export interface CommandOutput {
  readonly bytes: number;
  readonly sha256: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface CommandTermination {
  readonly status: 'not_needed' | 'confirmed' | 'failed';
  readonly escalated: boolean;
  readonly detail: string | null;
}

export interface RunCommandResult {
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly outputLimitStream: OutputStreamName | null;
  readonly reason: string | null;
  readonly stdout: CommandOutput;
  readonly stderr: CommandOutput;
  readonly termination: CommandTermination;
}

type RunningChild = ChildProcessByStdio<Writable | null, Readable, Readable>;
type TerminatingStatus = Exclude<CommandStatus, 'exited'>;

interface ValidatedCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: Buffer | null;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly captureLimitBytes: number;
  readonly signal: AbortSignal | undefined;
}

interface TerminationCause {
  readonly status: TerminatingStatus;
  readonly reason: string;
  readonly outputLimitStream: OutputStreamName | null;
}

interface WindowsTaskkillResult {
  readonly succeeded: boolean;
  readonly detail: string | null;
}

function noTermination(): CommandTermination {
  return {
    status: 'not_needed',
    escalated: false,
    detail: null,
  };
}

function decodeCapturedContent(
  captured: Buffer,
  byteLimit: number,
): { readonly content: string; readonly complete: boolean } {
  const decoded = new StringDecoder('utf8').write(captured);
  const decodedBytes = Buffer.byteLength(decoded);
  if (decodedBytes <= byteLimit) {
    return {
      content: decoded,
      complete: decodedBytes === captured.byteLength,
    };
  }

  const characters: string[] = [];
  let contentBytes = 0;
  for (const character of decoded) {
    const characterBytes = Buffer.byteLength(character);
    if (contentBytes + characterBytes > byteLimit) {
      break;
    }
    characters.push(character);
    contentBytes += characterBytes;
  }
  return {
    content: characters.join(''),
    complete: false,
  };
}

class OutputCapture {
  readonly #captureLimitBytes: number;
  readonly #outputLimitBytes: number;
  readonly #hash: Hash;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #capturedBytes = 0;
  #snapshotted = false;

  constructor(outputLimitBytes: number, captureLimitBytes: number) {
    this.#outputLimitBytes = outputLimitBytes;
    this.#captureLimitBytes = captureLimitBytes;
    this.#hash = createHash('sha256');
  }

  append(chunk: Buffer): boolean {
    this.#bytes += chunk.byteLength;
    this.#hash.update(chunk);

    const remainingCaptureBytes = this.#captureLimitBytes - this.#capturedBytes;
    if (remainingCaptureBytes > 0) {
      const captured = Buffer.from(chunk.subarray(0, remainingCaptureBytes));
      this.#chunks.push(captured);
      this.#capturedBytes += captured.byteLength;
    }

    return this.#bytes > this.#outputLimitBytes;
  }

  snapshot(): CommandOutput {
    if (this.#snapshotted) {
      throw new Error('Command output was finalized more than once.');
    }
    this.#snapshotted = true;
    const captured = Buffer.concat(this.#chunks, this.#capturedBytes);
    const decoded = decodeCapturedContent(captured, this.#captureLimitBytes);

    return {
      bytes: this.#bytes,
      sha256: this.#hash.digest('hex'),
      content: decoded.content,
      truncated: this.#bytes > this.#capturedBytes || !decoded.complete,
    };
  }
}

function validateString(
  value: unknown,
  field: string,
  allowEmpty: boolean,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
  if (value.includes('\u0000')) {
    throw new TypeError(`${field} must not contain NUL bytes.`);
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AbortSignal>;
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function validateOptions(options: RunCommandOptions): ValidatedCommand {
  const providedArgv: unknown = options.argv;
  if (!Array.isArray(providedArgv)) {
    throw new TypeError('argv must be an array of strings.');
  }
  const argv = providedArgv as readonly unknown[];
  if (argv.length === 0) {
    throw new TypeError('argv must contain an executable.');
  }

  for (const [index, value] of argv.entries()) {
    validateString(value, index === 0 ? 'argv[0]' : `argv[${String(index)}]`, index !== 0);
  }

  validateString(options.cwd, 'cwd', false);
  const providedEnv: unknown = options.env;
  if (typeof providedEnv !== 'object' || providedEnv === null || Array.isArray(providedEnv)) {
    throw new TypeError('env must be an object containing explicit string values.');
  }

  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(providedEnv as Readonly<Record<string, unknown>>)) {
    validateString(key, 'An environment variable name', false);
    if (key.includes('=')) {
      throw new TypeError('Environment variable names must not contain equals signs.');
    }
    validateString(value, 'An environment variable value', true);
    env[key] = value;
  }

  const providedStdin: unknown = options.stdin;
  if (providedStdin !== null && !Buffer.isBuffer(providedStdin)) {
    throw new TypeError('stdin must be a Buffer or null.');
  }
  const stdin = providedStdin === null ? null : Buffer.from(providedStdin);

  validateNonNegativeSafeInteger(options.stdoutLimitBytes, 'stdoutLimitBytes');
  validateNonNegativeSafeInteger(options.stderrLimitBytes, 'stderrLimitBytes');
  validateNonNegativeSafeInteger(options.captureLimitBytes, 'captureLimitBytes');
  if (
    options.captureLimitBytes > options.stdoutLimitBytes ||
    options.captureLimitBytes > options.stderrLimitBytes
  ) {
    throw new RangeError('captureLimitBytes must not exceed either stream output limit.');
  }

  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMER_MILLISECONDS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${String(MAX_TIMER_MILLISECONDS)}.`,
    );
  }
  const providedSignal: unknown = options.signal;
  if (providedSignal !== undefined && !isAbortSignal(providedSignal)) {
    throw new TypeError('signal must be an AbortSignal.');
  }

  const executable = argv[0];
  if (executable === undefined) {
    throw new TypeError('argv must contain an executable.');
  }
  validateString(executable, 'argv[0]', false);

  const argumentsList = argv.slice(1);

  return {
    executable,
    arguments: argumentsList as readonly string[],
    cwd: options.cwd,
    env,
    stdin,
    timeoutMs: options.timeoutMs,
    stdoutLimitBytes: options.stdoutLimitBytes,
    stderrLimitBytes: options.stderrLimitBytes,
    captureLimitBytes: options.captureLimitBytes,
    signal: providedSignal,
  };
}

function spawnCommand(command: ValidatedCommand): RunningChild {
  if (command.stdin === null) {
    return spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      detached: process.platform !== 'win32',
      env: command.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(command.executable, command.arguments, {
    cwd: command.cwd,
    detached: process.platform !== 'win32',
    env: command.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,32}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'UNKNOWN';
}

function isEarlyStdinCloseCode(code: string): boolean {
  return code === 'EPIPE' || code === 'EOF' || code === 'ECONNRESET';
}

function durationSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function emptyOutput(): CommandOutput {
  return {
    bytes: 0,
    sha256: EMPTY_SHA256,
    content: '',
    truncated: false,
  };
}

function preStartAbortResult(startedAt: number): RunCommandResult {
  return {
    status: 'aborted',
    exitCode: null,
    signal: null,
    durationMs: durationSince(startedAt),
    outputLimitStream: null,
    reason: 'Command execution was aborted before start.',
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    termination: noTermination(),
  };
}

function spawnFailureResult(startedAt: number, error: unknown): RunCommandResult {
  return {
    status: 'spawn_error',
    exitCode: null,
    signal: null,
    durationMs: durationSince(startedAt),
    outputLimitStream: null,
    reason: `Command could not be started (${safeErrorCode(error)}).`,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    termination: noTermination(),
  };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isProcessGroupRunning(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    return safeErrorCode(error) !== 'ESRCH';
  }
}

function signalProcessGroup(
  processId: number,
  signal: NodeJS.Signals,
): 'sent' | 'absent' | 'failed' {
  try {
    process.kill(-processId, signal);
    return 'sent';
  } catch (error) {
    return safeErrorCode(error) === 'ESRCH' ? 'absent' : 'failed';
  }
}

function tryDirectKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The structured termination result reports whether the process tree was confirmed gone.
  }
}

async function terminateUnixProcessTree(child: ChildProcess): Promise<CommandTermination> {
  const processId = child.pid;
  if (processId === undefined) {
    return {
      status: 'failed',
      escalated: false,
      detail: 'Unix process-tree termination could not start because no process id was available.',
    };
  }

  const gracefulSignal = signalProcessGroup(processId, 'SIGTERM');
  if (gracefulSignal === 'absent') {
    return {
      status: 'confirmed',
      escalated: false,
      detail: null,
    };
  }
  if (gracefulSignal === 'failed') {
    tryDirectKill(child, 'SIGTERM');
  }

  await wait(GRACEFUL_TERMINATION_MILLISECONDS);
  if (!isProcessGroupRunning(processId)) {
    return {
      status: 'confirmed',
      escalated: false,
      detail: null,
    };
  }

  const forcedSignal = signalProcessGroup(processId, 'SIGKILL');
  if (forcedSignal === 'failed') {
    tryDirectKill(child, 'SIGKILL');
  }
  await wait(FORCED_TERMINATION_MILLISECONDS);

  if (!isProcessGroupRunning(processId)) {
    return {
      status: 'confirmed',
      escalated: true,
      detail: null,
    };
  }
  return {
    status: 'failed',
    escalated: true,
    detail: 'Unix process-tree termination could not be confirmed after SIGKILL.',
  };
}

async function runWindowsTaskkill(processId: number): Promise<WindowsTaskkillResult> {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const executable = win32.join(windowsDirectory, 'System32', 'taskkill.exe');
  const options: SpawnOptions = {
    cwd: windowsDirectory,
    env: {
      SystemRoot: windowsDirectory,
      WINDIR: windowsDirectory,
    },
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  };

  return await new Promise<WindowsTaskkillResult>((resolve) => {
    let terminator: ChildProcess;
    try {
      terminator = spawn(executable, ['/PID', String(processId), '/T', '/F'], options);
    } catch (error) {
      resolve({
        succeeded: false,
        detail: `taskkill could not start (${safeErrorCode(error)}).`,
      });
      return;
    }

    let settled = false;
    const finish = (result: WindowsTaskkillResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (terminator.pid !== undefined) {
        terminator.unref();
      }
      resolve(result);
    };
    const timeout = setTimeout(() => {
      tryDirectKill(terminator, 'SIGKILL');
      finish({
        succeeded: false,
        detail: 'taskkill did not settle within its bounded timeout.',
      });
    }, WINDOWS_TERMINATOR_TIMEOUT_MILLISECONDS);

    terminator.once('error', (error) => {
      finish({
        succeeded: false,
        detail: `taskkill failed (${safeErrorCode(error)}).`,
      });
    });
    terminator.once('close', (code) => {
      finish(
        code === 0
          ? { succeeded: true, detail: null }
          : {
              succeeded: false,
              detail: `taskkill exited with code ${code === null ? 'unknown' : String(code)}.`,
            },
      );
    });
  });
}

async function terminateWindowsProcessTree(child: ChildProcess): Promise<CommandTermination> {
  const processId = child.pid;
  if (processId === undefined) {
    return {
      status: 'failed',
      escalated: true,
      detail:
        'Windows process-tree termination could not start because no process id was available.',
    };
  }

  const taskkill = await runWindowsTaskkill(processId);
  if (taskkill.succeeded) {
    return {
      status: 'confirmed',
      escalated: true,
      detail: null,
    };
  }

  tryDirectKill(child, 'SIGKILL');
  await wait(FORCED_TERMINATION_MILLISECONDS);
  return {
    status: 'failed',
    escalated: true,
    detail: `Windows process-tree termination could not be confirmed: ${taskkill.detail ?? 'taskkill failed without a diagnostic.'}`,
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<CommandTermination> {
  return process.platform === 'win32'
    ? await terminateWindowsProcessTree(child)
    : await terminateUnixProcessTree(child);
}

async function cleanupExitedProcessTree(
  child: ChildProcess,
  startedAtUnixMilliseconds: number,
  closedAtUnixMilliseconds: number,
): Promise<CommandTermination> {
  const processId = child.pid;
  if (processId === undefined) {
    return {
      status: 'failed',
      escalated: false,
      detail: 'Exited process-tree cleanup could not start because no process id was available.',
    };
  }

  if (process.platform !== 'win32') {
    return isProcessGroupRunning(processId)
      ? await terminateUnixProcessTree(child)
      : noTermination();
  }

  const cleanup = await cleanupExitedWindowsDescendants(
    processId,
    startedAtUnixMilliseconds,
    closedAtUnixMilliseconds,
  );
  switch (cleanup.kind) {
    case 'none':
      return noTermination();
    case 'confirmed':
      return {
        status: 'confirmed',
        escalated: true,
        detail: null,
      };
    case 'failed':
      return {
        status: 'failed',
        escalated: true,
        detail: cleanup.detail,
      };
  }
}

async function waitForBoundedClose(closed: Promise<void>): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (wasClosed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(wasClosed);
    };
    const timeout = setTimeout(() => {
      finish(false);
    }, CLOSE_DRAIN_MILLISECONDS);

    void closed.then(() => {
      finish(true);
    });
  });
}

/**
 * Executes one argv-only command in an explicit environment and working directory.
 *
 * The command never runs through a shell. Output is hashed incrementally and only the
 * configured capture prefix is retained in memory.
 */
export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const startedAtUnixMilliseconds = Date.now();
  const startedAt = performance.now();
  const command = validateOptions(options);
  if (command.signal?.aborted === true) {
    return preStartAbortResult(startedAt);
  }
  warmWindowsTreeHelper();

  let child: RunningChild;
  try {
    child = spawnCommand(command);
  } catch (error) {
    return spawnFailureResult(startedAt, error);
  }

  const stdout = new OutputCapture(command.stdoutLimitBytes, command.captureLimitBytes);
  const stderr = new OutputCapture(command.stderrLimitBytes, command.captureLimitBytes);

  return await new Promise<RunCommandResult>((resolve) => {
    let settled = false;
    let spawned = false;
    let cause: TerminationCause | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stdinCloseErrorCode: string | null = null;
    let naturalClosePending = false;
    let markChildClosed: (() => void) | undefined;
    const childClosed = new Promise<void>((resolveClosed) => {
      markChildClosed = resolveClosed;
    });

    const timeout = setTimeout(() => {
      requestTermination({
        status: 'timed_out',
        reason: `Command exceeded its ${String(command.timeoutMs)} ms timeout.`,
        outputLimitStream: null,
      });
    }, command.timeoutMs);

    const removeExternalTriggers = (): void => {
      clearTimeout(timeout);
      command.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (
      status: CommandStatus,
      reason: string | null,
      outputLimitStream: OutputStreamName | null,
      termination: CommandTermination,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeExternalTriggers();
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();

      resolve({
        status,
        exitCode: child.exitCode ?? exitCode,
        signal: child.signalCode ?? exitSignal,
        durationMs: durationSince(startedAt),
        outputLimitStream,
        reason,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
        termination,
      });
    };

    function requestTermination(nextCause: TerminationCause): void {
      if (settled || cause !== null || naturalClosePending) {
        return;
      }
      cause = nextCause;
      removeExternalTriggers();

      async function terminateAndDrain(): Promise<void> {
        let termination: CommandTermination;
        try {
          termination = await terminateProcessTree(child);
        } catch {
          termination = {
            status: 'failed',
            escalated: true,
            detail: 'Process-tree termination failed unexpectedly and could not be confirmed.',
          };
        }

        const closed = await waitForBoundedClose(childClosed);
        if (!closed && termination.status === 'confirmed') {
          termination = {
            status: 'failed',
            escalated: termination.escalated,
            detail:
              'Process-tree termination completed, but child close and output drain were not observed.',
          };
        }
        finish(nextCause.status, nextCause.reason, nextCause.outputLimitStream, termination);
      }

      void terminateAndDrain();
    }

    function onAbort(): void {
      requestTermination({
        status: 'aborted',
        reason: 'Command execution was aborted.',
        outputLimitStream: null,
      });
    }

    function onStdinError(error: unknown): void {
      if (settled || cause !== null) {
        return;
      }
      const code = safeErrorCode(error);
      if (isEarlyStdinCloseCode(code)) {
        stdinCloseErrorCode = code;
        return;
      }
      requestTermination({
        status: 'spawn_error',
        reason: `Command stdin failed (${code}).`,
        outputLimitStream: null,
      });
    }

    child.once('spawn', () => {
      spawned = true;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.append(chunk)) {
        requestTermination({
          status: 'output_limit',
          reason: `Command stdout exceeded its ${String(command.stdoutLimitBytes)} byte limit.`,
          outputLimitStream: 'stdout',
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.append(chunk)) {
        requestTermination({
          status: 'output_limit',
          reason: `Command stderr exceeded its ${String(command.stderrLimitBytes)} byte limit.`,
          outputLimitStream: 'stderr',
        });
      }
    });
    child.once('error', (error) => {
      if (!spawned && child.pid === undefined) {
        finish(
          'spawn_error',
          `Command could not be started (${safeErrorCode(error)}).`,
          null,
          noTermination(),
        );
        return;
      }

      requestTermination({
        status: 'spawn_error',
        reason: `Command process control failed (${safeErrorCode(error)}).`,
        outputLimitStream: null,
      });
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      markChildClosed?.();
      if (cause === null) {
        naturalClosePending = true;
        removeExternalTriggers();

        async function cleanupAndFinish(): Promise<void> {
          let termination: CommandTermination;
          try {
            termination = await cleanupExitedProcessTree(
              child,
              startedAtUnixMilliseconds,
              Date.now(),
            );
          } catch {
            termination = {
              status: 'failed',
              escalated: true,
              detail: 'Exited process-tree cleanup failed unexpectedly.',
            };
          }

          if (stdinCloseErrorCode !== null && (code !== 0 || signal !== null)) {
            finish(
              'spawn_error',
              `Command stdin closed before input was accepted (${stdinCloseErrorCode}).`,
              null,
              termination,
            );
          } else {
            finish('exited', null, null, termination);
          }
        }

        void cleanupAndFinish();
      }
    });

    command.signal?.addEventListener('abort', onAbort, { once: true });
    if (command.signal?.aborted === true) {
      onAbort();
    }
    if (command.stdin !== null) {
      const childStdin = child.stdin;
      if (childStdin === null) {
        requestTermination({
          status: 'spawn_error',
          reason: 'Command stdin pipe was unavailable (UNKNOWN).',
          outputLimitStream: null,
        });
      } else {
        childStdin.on('error', onStdinError);
        try {
          childStdin.end(command.stdin);
        } catch (error) {
          onStdinError(error);
        }
      }
    }
  });
}
