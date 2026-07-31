import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';

import { canonicalJson, type CanonicalJsonValue } from '../canonical/index.js';
import { loadManifest } from '../config/index.js';
import { FixtureError, HarnessError } from '../domain/errors.js';
import type { LoadedManifest, PlatformName, ProgramSpec } from '../domain/model.js';
import {
  mergeRunCommand,
  validateCommandMetadata,
  type CommandResolutionContext,
} from '../runtime/index.js';
import {
  captureFilesystemSnapshot,
  type FilesystemSnapshotError,
  type FilesystemSnapshot,
} from '../snapshot/index.js';
import {
  materializeSeed,
  prepareSuite,
  type PreparedStateRoot,
  type PreparedSuite,
} from '../workspace/index.js';

const SNAPSHOT_MAX_DEPTH = 64;

export type SuiteCommandName = 'doctor' | 'inspect' | 'validate';
export type SuiteCommandFormat = 'human' | 'json';

export interface SafeStateRootMetadata {
  readonly id: string;
  readonly kind: 'copy' | 'empty';
  readonly sourceDigest: string;
  readonly totalBytes: number;
}

export interface SafeSuiteMetadata {
  readonly cases: {
    readonly count: number;
    readonly ids: readonly string[];
  };
  readonly prepared: {
    readonly digest: string;
    readonly entries: number;
    readonly totalBytes: number;
  };
  readonly schema: 'ghostcase/suite/v1';
  readonly sourceSha256: string;
  readonly stateRoots: readonly SafeStateRootMetadata[];
  readonly suite: {
    readonly id: string;
  };
}

export interface ValidateSuiteData extends SafeSuiteMetadata {
  readonly command: 'validate';
}

export type SafeProgramSummary =
  | {
      readonly kind: 'lookup';
      readonly name: string;
    }
  | {
      readonly kind: 'path';
      readonly path: string;
    };

export interface SafeCasePlan {
  readonly argvCount: number;
  readonly id: string;
  readonly mergedArgvCount: number;
  readonly platforms: readonly PlatformName[];
  readonly setupCommandCount: number;
  readonly tags: readonly string[];
}

export interface InspectSuiteData extends SafeSuiteMetadata {
  readonly adapter: {
    readonly argvCount: number;
    readonly program: SafeProgramSummary;
    readonly resetCommandCount: number;
    readonly setupCommandCount: number;
    readonly snapshotRoots: readonly string[];
  };
  readonly casePlans: readonly SafeCasePlan[];
  readonly command: 'inspect';
  readonly execution: {
    readonly armTimeoutMs: number;
    readonly caseTimeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly maxSnapshotBytes: number;
    readonly maxSnapshotEntries: number;
    readonly maxSnapshotFileBytes: number;
    readonly maxStderrBytes: number;
    readonly maxStdinBytes: number;
    readonly maxStdoutBytes: number;
    readonly stepTimeoutMs: number;
    readonly suiteTimeoutMs: number;
  };
  readonly search: {
    readonly maxChainLength: number;
    readonly maxExperiments: number;
    readonly repetitions: number;
  };
}

export interface DoctorSuiteData extends SafeSuiteMetadata {
  readonly checks: {
    readonly commands: 'ok';
    readonly fixtures: 'ok';
    readonly manifest: 'ok';
    readonly materialize: 'ok';
    readonly snapshot: 'ok';
  };
  readonly command: 'doctor';
  readonly resolvedCommandCount: number;
  readonly snapshot: {
    readonly aggregateDigest: string;
    readonly entries: number;
    readonly roots: readonly string[];
    readonly specDigest: string;
    readonly totalBytes: number;
  };
  readonly stdinContentsChecked: false;
}

export type SuiteCommandData = DoctorSuiteData | InspectSuiteData | ValidateSuiteData;

export interface SuiteCommandResult {
  readonly data: SuiteCommandData;
  readonly exitCode: 0 | 2 | 3;
}

interface LoadedSuite {
  readonly manifest: LoadedManifest;
  readonly prepared: PreparedSuite;
}

export async function runSuiteCommand(
  command: SuiteCommandName,
  suitePath: string,
): Promise<SuiteCommandResult> {
  const loaded = await loadAndPrepare(suitePath);
  const common = safeSuiteMetadata(loaded.manifest, loaded.prepared);

  switch (command) {
    case 'validate':
      return freezeResult({
        exitCode: 0,
        data: {
          ...common,
          command,
        },
      });
    case 'inspect':
      return freezeResult({
        exitCode: 0,
        data: inspectSuite(loaded.manifest, common),
      });
    case 'doctor':
      return freezeResult({
        exitCode: 0,
        data: await doctorSuite(loaded.manifest, loaded.prepared, common),
      });
  }
}

export function formatSuiteCommand(result: SuiteCommandResult, format: SuiteCommandFormat): string {
  if (format === 'json') {
    return `${canonicalJson(result as unknown as CanonicalJsonValue)}\n`;
  }
  return `${formatHuman(result)}\n`;
}

async function loadAndPrepare(suitePath: string): Promise<LoadedSuite> {
  const manifest = await loadManifest(suitePath);
  const prepared = await prepareSuite(manifest);
  return { manifest, prepared };
}

function safeSuiteMetadata(manifest: LoadedManifest, prepared: PreparedSuite): SafeSuiteMetadata {
  return {
    cases: {
      count: manifest.definition.cases.length,
      ids: manifest.definition.cases.map(({ id }) => id),
    },
    prepared: {
      digest: prepared.snapshot.digest,
      entries: prepared.snapshot.entries.length,
      totalBytes: prepared.snapshot.totalBytes,
    },
    schema: manifest.definition.schema,
    sourceSha256: manifest.sourceSha256,
    stateRoots: prepared.stateRoots.map(safeStateRoot),
    suite: {
      id: manifest.definition.suite.id,
    },
  };
}

function safeStateRoot(root: PreparedStateRoot): SafeStateRootMetadata {
  return {
    id: root.id,
    kind: root.kind,
    sourceDigest: root.sourceDigest,
    totalBytes: root.totalBytes,
  };
}

function inspectSuite(manifest: LoadedManifest, common: SafeSuiteMetadata): InspectSuiteData {
  const { adapter, cases, execution, suite } = manifest.definition;
  return {
    ...common,
    adapter: {
      argvCount: adapter.run.argv.length,
      program: summarizeProgram(adapter.run.program),
      resetCommandCount: adapter.reset.length,
      setupCommandCount: adapter.setup.length,
      snapshotRoots: adapter.snapshot.roots.map(({ root }) => root),
    },
    casePlans: cases.map((caseSpec) => ({
      argvCount: caseSpec.run.argv.length,
      id: caseSpec.id,
      mergedArgvCount: adapter.run.argv.length + caseSpec.run.argv.length,
      platforms: [...caseSpec.platforms],
      setupCommandCount: caseSpec.setup.length,
      tags: [...caseSpec.tags],
    })),
    command: 'inspect',
    execution: {
      armTimeoutMs: execution.armTimeoutMs,
      caseTimeoutMs: execution.caseTimeoutMs,
      cleanupTimeoutMs: execution.cleanupTimeoutMs,
      maxSnapshotBytes: execution.maxSnapshotBytes,
      maxSnapshotEntries: execution.maxSnapshotEntries,
      maxSnapshotFileBytes: execution.maxSnapshotFileBytes,
      maxStderrBytes: execution.maxStderrBytes,
      maxStdinBytes: execution.maxStdinBytes,
      maxStdoutBytes: execution.maxStdoutBytes,
      stepTimeoutMs: execution.stepTimeoutMs,
      suiteTimeoutMs: execution.suiteTimeoutMs,
    },
    search: {
      maxChainLength: suite.search.maxChainLength,
      maxExperiments: suite.search.maxExperiments,
      repetitions: suite.repetitions,
    },
  };
}

function summarizeProgram(program: ProgramSpec): SafeProgramSummary {
  return 'lookup' in program
    ? {
        kind: 'lookup',
        name: program.lookup,
      }
    : {
        kind: 'path',
        path: program.path,
      };
}

async function doctorSuite(
  manifest: LoadedManifest,
  prepared: PreparedSuite,
  common: SafeSuiteMetadata,
): Promise<DoctorSuiteData> {
  const temporaryRoot = await realpath(tmpdir());
  const workspace = await materializeSeed(prepared.snapshot, {
    prefix: 'ghostcase-doctor-',
    temporaryRoot,
  });

  try {
    const stateRoots = new Map(
      manifest.definition.stateRoots.map(({ id }) => [id, join(workspace.root, 'state', id)]),
    );
    const context: CommandResolutionContext = {
      armRoot: workspace.root,
      hostEnvironment: Object.freeze({ ...process.env }),
      maxStdinBytes: manifest.definition.execution.maxStdinBytes,
      stateRoots,
      suiteDir: manifest.suiteDir,
      tempRoot: join(workspace.root, 'temp'),
    };

    const resolvedCommandCount = await resolveDoctorCommands(manifest, context);
    const snapshot = await captureDoctorSnapshot(manifest, workspace.root);

    return {
      ...common,
      checks: {
        commands: 'ok',
        fixtures: 'ok',
        manifest: 'ok',
        materialize: 'ok',
        snapshot: 'ok',
      },
      command: 'doctor',
      resolvedCommandCount,
      snapshot: {
        aggregateDigest: snapshot.aggregateDigest,
        entries: snapshot.counts.entries,
        roots: manifest.definition.adapter.snapshot.roots.map(({ root }) => root),
        specDigest: snapshot.specDigest,
        totalBytes: snapshot.counts.totalBytes,
      },
      stdinContentsChecked: false,
    };
  } finally {
    await workspace.cleanup();
  }
}

async function resolveDoctorCommands(
  manifest: LoadedManifest,
  context: CommandResolutionContext,
): Promise<number> {
  const { adapter, cases, environment } = manifest.definition;
  const commands = [
    ...adapter.setup,
    adapter.run,
    ...adapter.reset,
    ...cases.flatMap((caseSpec) => [...caseSpec.setup, mergeRunCommand(adapter.run, caseSpec.run)]),
  ];

  for (const command of commands) {
    try {
      await validateCommandMetadata(command, environment, context, {
        allowUnmaterializedDynamicStdin: true,
      });
    } catch (error) {
      throw new HarnessError('Doctor could not resolve a configured command safely.', {
        cause: error,
      });
    }
  }
  return commands.length;
}

async function captureDoctorSnapshot(
  manifest: LoadedManifest,
  workspaceRoot: string,
): Promise<FilesystemSnapshot> {
  const execution = manifest.definition.execution;
  const result = await captureFilesystemSnapshot({
    limits: {
      maxDepth: SNAPSHOT_MAX_DEPTH,
      maxEntries: execution.maxSnapshotEntries,
      maxFileBytes: execution.maxSnapshotFileBytes,
      maxTotalBytes: execution.maxSnapshotBytes,
    },
    roots: manifest.definition.adapter.snapshot.roots.map(({ root }) => ({
      alias: root,
      path: `state/${root}`,
    })),
    workspaceRoot,
  });
  if (result.status === 'failed') {
    throw snapshotError(result.error);
  }
  return result;
}

function snapshotError(error: FilesystemSnapshotError): FixtureError | HarnessError {
  const detail = safeSnapshotErrorDetail(error);
  if (error.code === 'IO_ERROR' || error.code === 'UNSTABLE_STATE') {
    return new HarnessError(`Doctor could not capture a stable fixture snapshot (${detail}).`);
  }
  return new FixtureError(`Doctor rejected the fixture snapshot (${detail}).`);
}

function safeSnapshotErrorDetail(error: FilesystemSnapshotError): string {
  switch (error.code) {
    case 'INVALID_CONFIG':
      return `${error.code}:${error.reason}`;
    case 'IO_ERROR':
      return `${error.code}:${error.operation}:${error.systemCode}`;
    case 'LIMIT_EXCEEDED':
      return `${error.code}:${error.limit}`;
    case 'UNSAFE_PATH':
      return `${error.code}:${error.reason}`;
    case 'UNSTABLE_STATE':
      return `${error.code}:${error.operation}`;
    case 'UNSUPPORTED_FILE_TYPE':
      return error.code;
  }
}

function formatHuman(result: SuiteCommandResult): string {
  const { data } = result;
  const lines = commonHumanLines(data);
  switch (data.command) {
    case 'validate':
      lines.unshift('GhostCase suite valid');
      break;
    case 'inspect':
      lines.unshift('GhostCase suite inspection');
      lines.push(
        `Search: repetitions=${String(data.search.repetitions)}, max chain=${String(
          data.search.maxChainLength,
        )}, max experiments=${String(data.search.maxExperiments)}`,
        `Execution: step=${String(data.execution.stepTimeoutMs)}ms, case=${String(
          data.execution.caseTimeoutMs,
        )}ms, arm=${String(data.execution.armTimeoutMs)}ms, suite=${String(
          data.execution.suiteTimeoutMs,
        )}ms`,
        `Adapter: ${formatProgram(data.adapter.program)}, argv=${String(
          data.adapter.argvCount,
        )}, setup=${String(data.adapter.setupCommandCount)}, reset=${String(
          data.adapter.resetCommandCount,
        )}`,
        `Snapshot roots: ${data.adapter.snapshotRoots.join(', ')}`,
        'Case plans:',
        ...data.casePlans.map(
          (casePlan) =>
            `  ${casePlan.id}: argv=${String(casePlan.argvCount)}, merged argv=${String(
              casePlan.mergedArgvCount,
            )}, setup=${String(casePlan.setupCommandCount)}, platforms=${casePlan.platforms.join(
              ',',
            )}, tags=${casePlan.tags.join(',')}`,
        ),
      );
      break;
    case 'doctor':
      lines.unshift('GhostCase doctor passed');
      lines.push(
        `Checks: manifest=${data.checks.manifest}, fixtures=${data.checks.fixtures}, materialize=${data.checks.materialize}, commands=${data.checks.commands}, snapshot=${data.checks.snapshot}`,
        `Resolved commands: ${String(data.resolvedCommandCount)}`,
        'Stdin contents checked: no',
        `Snapshot: ${data.snapshot.aggregateDigest} (${String(
          data.snapshot.entries,
        )} entries, ${String(data.snapshot.totalBytes)} bytes)`,
      );
      break;
  }
  return lines.join('\n');
}

function commonHumanLines(data: SuiteCommandData): string[] {
  return [
    `Suite: ${data.suite.id}`,
    `Schema: ${data.schema}`,
    `Source SHA-256: ${data.sourceSha256}`,
    `Cases (${String(data.cases.count)}): ${data.cases.ids.join(', ')}`,
    `State roots: ${data.stateRoots
      .map(
        (root) =>
          `${root.id} (${root.kind}, ${String(root.totalBytes)} bytes, ${root.sourceDigest})`,
      )
      .join(', ')}`,
    `Prepared seed: ${data.prepared.digest} (${String(
      data.prepared.entries,
    )} entries, ${String(data.prepared.totalBytes)} bytes)`,
  ];
}

function formatProgram(program: SafeProgramSummary): string {
  return program.kind === 'lookup'
    ? `lookup ${program.name}`
    : `suite-relative path ${program.path}`;
}

function freezeResult(result: SuiteCommandResult): SuiteCommandResult {
  return deepFreeze(result);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
