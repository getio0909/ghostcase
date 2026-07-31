import { join } from 'node:path';

import type { CaseSpec, CommandSpec, LoadedManifest } from '../domain/model.js';
import { evaluateOracle, type OracleEvaluation, type OracleOutcome } from '../oracle/index.js';
import { runCommand, type RunCommandResult } from '../process/index.js';
import {
  mergeRunCommand,
  resolveCommand,
  type CommandResolutionContext,
  type ResolvedCommand,
} from '../runtime/index.js';
import {
  captureFilesystemSnapshot,
  diffFilesystemSnapshots,
  type CompleteFilesystemDiff,
  type FilesystemSnapshot,
} from '../snapshot/index.js';
import { materializeSeed, type SeedSnapshot } from '../workspace/index.js';

const SNAPSHOT_MAX_DEPTH = 64;

export interface ExecuteArmOptions {
  readonly manifest: LoadedManifest;
  readonly predecessorCases: readonly CaseSpec[];
  readonly seed: SeedSnapshot;
  readonly signal?: AbortSignal;
  readonly temporaryRoot: string;
  readonly victimCase: CaseSpec;
}

export interface SafeCommandOutput {
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface SafeCommandTermination {
  readonly escalated: boolean;
  readonly status: 'confirmed' | 'failed' | 'not_needed';
}

export interface SafeCommandResult {
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly outputLimitStream: 'stderr' | 'stdout' | null;
  readonly signal: NodeJS.Signals | null;
  readonly status: 'aborted' | 'exited' | 'output_limit' | 'spawn_error' | 'timed_out';
  readonly stderr: SafeCommandOutput;
  readonly stdout: SafeCommandOutput;
  readonly termination: SafeCommandTermination;
}

export interface ArmCaseResult {
  readonly caseId: string;
  readonly outcome: Extract<OracleOutcome, 'fail' | 'pass'>;
  readonly process: SafeCommandResult;
  readonly semanticSignature: string;
}

export interface ValidArmResult {
  readonly predecessorResidue: CompleteFilesystemDiff;
  readonly predecessors: readonly ArmCaseResult[];
  readonly status: 'valid';
  readonly victim: ArmCaseResult;
}

export type InvalidArmPhase =
  | 'adapter_setup'
  | 'arm'
  | 'baseline_snapshot'
  | 'cleanup'
  | 'materialize'
  | 'pre_victim_snapshot'
  | 'predecessor'
  | 'reset'
  | 'victim';

export type InvalidArmReason =
  | 'ABORTED'
  | 'ARM_TIMEOUT'
  | 'CLEANUP_FAILED'
  | 'COMMAND_RESOLUTION_FAILED'
  | 'DIFF_FAILED'
  | 'INTERNAL_ERROR'
  | 'MATERIALIZATION_FAILED'
  | 'ORACLE_FAILED'
  | 'ORACLE_INVALID'
  | 'PROCESS_ABNORMAL'
  | 'RESET_FAILED'
  | 'SETUP_FAILED'
  | 'SNAPSHOT_FAILED';

export interface InvalidArmResult {
  readonly caseId?: string;
  readonly phase: InvalidArmPhase;
  readonly process?: SafeCommandResult;
  readonly reason: InvalidArmReason;
  readonly status: 'invalid';
}

export type ExecuteArmResult = InvalidArmResult | ValidArmResult;

interface ArmContext {
  readonly command: CommandResolutionContext;
  readonly manifest: LoadedManifest;
  readonly signal: AbortSignal;
}

interface AbortScope {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

type CommandAttempt =
  | {
      readonly kind: 'abnormal';
      readonly result: RunCommandResult;
    }
  | {
      readonly kind: 'ok';
      readonly resolved: ResolvedCommand;
      readonly result: RunCommandResult;
    }
  | {
      readonly kind: 'resolution_failed';
    };

type SetupAttempt =
  | {
      readonly kind: 'failed';
      readonly process?: SafeCommandResult;
      readonly reason: 'COMMAND_RESOLUTION_FAILED' | 'PROCESS_ABNORMAL' | 'SETUP_FAILED';
    }
  | {
      readonly kind: 'ok';
    };

type CaseAttempt =
  | {
      readonly kind: 'failed';
      readonly process?: SafeCommandResult;
      readonly reason:
        | 'COMMAND_RESOLUTION_FAILED'
        | 'ORACLE_FAILED'
        | 'ORACLE_INVALID'
        | 'PROCESS_ABNORMAL'
        | 'SETUP_FAILED';
    }
  | {
      readonly evaluation: OracleEvaluation;
      readonly kind: 'ok';
      readonly process: SafeCommandResult;
    };

export async function executeArm(options: ExecuteArmOptions): Promise<ExecuteArmResult> {
  const predecessorCases = [...options.predecessorCases];
  const lifecycle = createAbortScope(
    options.signal,
    options.manifest.definition.execution.armTimeoutMs,
  );
  let armTimedOut = false;
  const timeout = setTimeout(() => {
    armTimedOut = true;
  }, options.manifest.definition.execution.armTimeoutMs);
  timeout.unref();

  let workspace:
    | {
        readonly cleanup: () => Promise<void>;
        readonly root: string;
      }
    | undefined;
  let result: ExecuteArmResult;

  try {
    if (lifecycle.signal.aborted) {
      return invalidAbort(options.signal, armTimedOut);
    }
    try {
      workspace = await materializeSeed(options.seed, {
        prefix: 'ghostcase-arm-',
        temporaryRoot: options.temporaryRoot,
      });
    } catch {
      return invalid('materialize', 'MATERIALIZATION_FAILED');
    }
    const activeWorkspace = workspace;

    const stateRoots = new Map(
      options.manifest.definition.stateRoots.map((root) => [
        root.id,
        join(activeWorkspace.root, 'state', root.id),
      ]),
    );
    const context: ArmContext = {
      command: {
        armRoot: activeWorkspace.root,
        hostEnvironment: Object.freeze({ ...process.env }),
        maxStdinBytes: options.manifest.definition.execution.maxStdinBytes,
        stateRoots,
        suiteDir: options.manifest.suiteDir,
        tempRoot: join(activeWorkspace.root, 'temp'),
      },
      manifest: options.manifest,
      signal: lifecycle.signal,
    };

    result = await executeMaterializedArm(context, predecessorCases, options.victimCase, () =>
      invalidAbort(options.signal, armTimedOut),
    );
  } catch {
    result = invalid('arm', 'INTERNAL_ERROR');
  } finally {
    clearTimeout(timeout);
    lifecycle.dispose();
  }

  if (workspace === undefined) {
    return result;
  }

  try {
    const resetSucceeded = await runReset(options.manifest, workspace.root);
    if (!resetSucceeded) {
      result = invalid('reset', 'RESET_FAILED');
    }
  } catch {
    result = invalid('reset', 'RESET_FAILED');
  } finally {
    const cleanupSucceeded = await settleWithin(
      Promise.resolve().then(workspace.cleanup),
      options.manifest.definition.execution.cleanupTimeoutMs,
    );
    if (!cleanupSucceeded) {
      result = invalid('cleanup', 'CLEANUP_FAILED');
    }
  }
  return result;
}

async function executeMaterializedArm(
  context: ArmContext,
  predecessorCases: readonly CaseSpec[],
  victimCase: CaseSpec,
  abortResult: () => InvalidArmResult,
): Promise<ExecuteArmResult> {
  if (hasAborted(context.signal)) {
    return abortResult();
  }

  const adapterSetup = await runSetupCommands(context.manifest.definition.adapter.setup, context);
  if (adapterSetup.kind === 'failed') {
    return invalid('adapter_setup', adapterSetup.reason, undefined, adapterSetup.process);
  }
  if (hasAborted(context.signal)) {
    return abortResult();
  }

  const baseline = await captureSnapshot(context);
  if (baseline === undefined) {
    return invalid('baseline_snapshot', 'SNAPSHOT_FAILED');
  }

  const predecessorResults: ArmCaseResult[] = [];
  for (const predecessor of predecessorCases) {
    if (hasAborted(context.signal)) {
      return abortResult();
    }
    const attempt = await runCase(predecessor, context);
    if (hasAborted(context.signal)) {
      return abortResult();
    }
    if (attempt.kind === 'failed') {
      return invalid('predecessor', attempt.reason, predecessor.id, attempt.process);
    }
    if (attempt.evaluation.kind !== 'pass') {
      return invalid(
        'predecessor',
        attempt.evaluation.kind === 'invalid' ? 'ORACLE_INVALID' : 'ORACLE_FAILED',
        predecessor.id,
        attempt.process,
      );
    }
    predecessorResults.push(caseResult(predecessor.id, attempt));
  }

  if (hasAborted(context.signal)) {
    return abortResult();
  }
  const preVictim = await captureSnapshot(context);
  if (preVictim === undefined) {
    return invalid('pre_victim_snapshot', 'SNAPSHOT_FAILED');
  }
  const predecessorResidue = diffFilesystemSnapshots(baseline, preVictim);
  if (predecessorResidue.status !== 'complete') {
    return invalid('pre_victim_snapshot', 'DIFF_FAILED');
  }

  if (hasAborted(context.signal)) {
    return abortResult();
  }
  const victim = await runCase(victimCase, context);
  if (hasAborted(context.signal)) {
    return abortResult();
  }
  if (victim.kind === 'failed') {
    return invalid('victim', victim.reason, victimCase.id, victim.process);
  }
  if (victim.evaluation.kind === 'invalid') {
    return invalid('victim', 'ORACLE_INVALID', victimCase.id, victim.process);
  }

  return Object.freeze({
    predecessorResidue,
    predecessors: Object.freeze(predecessorResults),
    status: 'valid',
    victim: caseResult(victimCase.id, victim),
  });
}

async function runCase(caseSpec: CaseSpec, context: ArmContext): Promise<CaseAttempt> {
  const scope = createAbortScope(
    context.signal,
    context.manifest.definition.execution.caseTimeoutMs,
  );
  try {
    const caseContext: ArmContext = {
      ...context,
      signal: scope.signal,
    };
    const setup = await runSetupCommands(caseSpec.setup, caseContext);
    if (setup.kind === 'failed') {
      return setup;
    }

    const command = mergeRunCommand(context.manifest.definition.adapter.run, caseSpec.run);
    const attempt = await runResolvedCommand(command, caseContext);
    if (attempt.kind === 'resolution_failed') {
      return {
        kind: 'failed',
        reason: 'COMMAND_RESOLUTION_FAILED',
      };
    }
    const process = safeCommandResult(attempt.result);
    if (attempt.kind === 'abnormal') {
      return {
        kind: 'failed',
        process,
        reason: 'PROCESS_ABNORMAL',
      };
    }

    const evaluation = await evaluateOracle(
      caseSpec.oracle ?? context.manifest.definition.adapter.oracle,
      {
        process: {
          exitCode: attempt.result.exitCode,
          status: attempt.result.status,
          stdout: {
            content: attempt.result.stdout.content,
            truncated: attempt.result.stdout.truncated,
          },
        },
        workspaceRoot: attempt.resolved.cwd,
      },
    );
    return {
      evaluation,
      kind: 'ok',
      process,
    };
  } catch {
    return {
      kind: 'failed',
      reason: 'ORACLE_INVALID',
    };
  } finally {
    scope.dispose();
  }
}

async function runSetupCommands(
  commands: readonly CommandSpec[],
  context: ArmContext,
): Promise<SetupAttempt> {
  for (const command of commands) {
    if (hasAborted(context.signal)) {
      return {
        kind: 'failed',
        reason: 'PROCESS_ABNORMAL',
      };
    }
    const attempt = await runResolvedCommand(command, context);
    if (attempt.kind === 'resolution_failed') {
      return {
        kind: 'failed',
        reason: 'COMMAND_RESOLUTION_FAILED',
      };
    }
    const process = safeCommandResult(attempt.result);
    if (attempt.kind === 'abnormal') {
      return {
        kind: 'failed',
        process,
        reason: 'PROCESS_ABNORMAL',
      };
    }
    if (attempt.result.exitCode !== 0) {
      return {
        kind: 'failed',
        process,
        reason: 'SETUP_FAILED',
      };
    }
  }
  return { kind: 'ok' };
}

async function runResolvedCommand(
  command: CommandSpec,
  context: ArmContext,
): Promise<CommandAttempt> {
  let resolved: ResolvedCommand;
  try {
    resolved = await resolveCommand(
      command,
      context.manifest.definition.environment,
      context.command,
    );
  } catch {
    return { kind: 'resolution_failed' };
  }

  const execution = context.manifest.definition.execution;
  const captureLimitBytes = Math.min(execution.maxStdoutBytes, execution.maxStderrBytes);
  let result: RunCommandResult;
  try {
    result = await runCommand({
      argv: resolved.argv,
      captureLimitBytes,
      cwd: resolved.cwd,
      env: resolved.env,
      signal: context.signal,
      stderrLimitBytes: execution.maxStderrBytes,
      stdin: resolved.stdin,
      stdoutLimitBytes: execution.maxStdoutBytes,
      timeoutMs: resolved.timeoutMs,
    });
  } catch {
    return { kind: 'resolution_failed' };
  }

  if (
    result.status !== 'exited' ||
    result.signal !== null ||
    result.termination.status === 'failed'
  ) {
    return {
      kind: 'abnormal',
      result,
    };
  }
  return {
    kind: 'ok',
    resolved,
    result,
  };
}

async function captureSnapshot(context: ArmContext): Promise<FilesystemSnapshot | undefined> {
  const execution = context.manifest.definition.execution;
  const result = await captureFilesystemSnapshot({
    limits: {
      maxDepth: SNAPSHOT_MAX_DEPTH,
      maxEntries: execution.maxSnapshotEntries,
      maxFileBytes: execution.maxSnapshotFileBytes,
      maxTotalBytes: execution.maxSnapshotBytes,
    },
    roots: context.manifest.definition.adapter.snapshot.roots.map((root) => ({
      alias: root.root,
      path: `state/${root.root}`,
    })),
    workspaceRoot: context.command.armRoot,
  });
  return result.status === 'complete' ? result : undefined;
}

async function runReset(manifest: LoadedManifest, armRoot: string): Promise<boolean> {
  const scope = createAbortScope(undefined, manifest.definition.execution.cleanupTimeoutMs);
  try {
    const stateRoots = new Map(
      manifest.definition.stateRoots.map((root) => [root.id, join(armRoot, 'state', root.id)]),
    );
    const context: ArmContext = {
      command: {
        armRoot,
        hostEnvironment: Object.freeze({ ...process.env }),
        maxStdinBytes: manifest.definition.execution.maxStdinBytes,
        stateRoots,
        suiteDir: manifest.suiteDir,
        tempRoot: join(armRoot, 'temp'),
      },
      manifest,
      signal: scope.signal,
    };
    const result = await runSetupCommands(manifest.definition.adapter.reset, context);
    return result.kind === 'ok' && !scope.signal.aborted;
  } catch {
    return false;
  } finally {
    scope.dispose();
  }
}

function caseResult(caseId: string, attempt: Extract<CaseAttempt, { kind: 'ok' }>): ArmCaseResult {
  if (attempt.evaluation.kind === 'invalid') {
    throw new TypeError('An invalid oracle evaluation cannot become a case result.');
  }
  return Object.freeze({
    caseId,
    outcome: attempt.evaluation.kind,
    process: attempt.process,
    semanticSignature: attempt.evaluation.semanticSignature,
  });
}

function safeCommandResult(result: RunCommandResult): SafeCommandResult {
  return Object.freeze({
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    outputLimitStream: result.outputLimitStream,
    signal: result.signal,
    status: result.status,
    stderr: safeOutput(result.stderr),
    stdout: safeOutput(result.stdout),
    termination: Object.freeze({
      escalated: result.termination.escalated,
      status: result.termination.status,
    }),
  });
}

function safeOutput(output: RunCommandResult['stdout']): SafeCommandOutput {
  return Object.freeze({
    bytes: output.bytes,
    sha256: output.sha256,
    truncated: output.truncated,
  });
}

function invalid(
  phase: InvalidArmPhase,
  reason: InvalidArmReason,
  caseId?: string,
  process?: SafeCommandResult,
): InvalidArmResult {
  return Object.freeze({
    ...(caseId === undefined ? {} : { caseId }),
    phase,
    ...(process === undefined ? {} : { process }),
    reason,
    status: 'invalid',
  });
}

function invalidAbort(signal: AbortSignal | undefined, armTimedOut: boolean): InvalidArmResult {
  return invalid('arm', signal?.aborted === true && !armTimedOut ? 'ABORTED' : 'ARM_TIMEOUT');
}

function hasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort();
  };
  parent?.addEventListener('abort', abortFromParent, { once: true });
  if (parent?.aborted === true) {
    controller.abort();
  }
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timeout.unref();

  return {
    dispose: (): void => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
    signal: controller.signal,
  };
}

async function settleWithin(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    task.then(
      () => true,
      () => false,
    ),
    new Promise<false>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs, false);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return outcome;
}
