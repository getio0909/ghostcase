import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadManifest } from '../config/index.js';
import { ConfigError } from '../domain/errors.js';
import type { CaseSpec, LoadedManifest } from '../domain/model.js';
import {
  diagnoseCases,
  type DiagnosisExecutionResult,
  type DiagnosisReport,
  type VictimDiagnosis,
} from '../experiment/diagnose.js';
import {
  executeArm,
  type ExecuteArmResult,
  type InvalidArmPhase,
  type InvalidArmReason,
} from '../experiment/execute-arm.js';
import {
  createReport,
  GHOSTCASE_REPORT_SCHEMA,
  summarizeArm,
  type GhostCaseReport,
  type GhostCaseVictimReportInput,
  type ReportExitCode,
  type ReportStatus,
} from '../report/index.js';
import type { CompleteFilesystemDiff } from '../snapshot/index.js';
import { version as VERSION } from '../version.js';
import { prepareSuite, type PreparedSuite } from '../workspace/index.js';
import { currentHostPlatform } from '../platform/host.js';

export interface RunSuiteOptions {
  readonly signal?: AbortSignal;
  readonly suitePath: string;
  readonly temporaryRoot?: string;
  readonly victimIds?: readonly string[];
}

/**
 * The report is the only serialization-safe public evidence artifact.
 *
 * `manifest` contains absolute host paths and `prepared` may contain fixture bytes. They are
 * returned for in-process replay only and must never be serialized, logged, or embedded in a
 * report.
 *
 * @internal
 */
export interface RunSuiteResult {
  readonly diagnosis: DiagnosisReport<CompleteFilesystemDiff>;
  readonly manifest: LoadedManifest;
  readonly prepared: PreparedSuite;
  readonly report: GhostCaseReport;
}

interface AbortScope {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

interface AggregateOutcome {
  readonly exitCode: ReportExitCode;
  readonly status: ReportStatus;
}

export async function runSuite(options: RunSuiteOptions): Promise<RunSuiteResult> {
  const manifest = await loadManifest(options.suitePath);
  const victims = selectVictims(manifest.definition.cases, options.victimIds);
  const scope = createAbortScope(options.signal, manifest.definition.execution.suiteTimeoutMs);

  try {
    const [prepared, temporaryRoot] = await Promise.all([
      prepareSuite(manifest),
      canonicalTemporaryRoot(options.temporaryRoot),
    ]);
    const diagnosis = await diagnoseCases<CompleteFilesystemDiff>({
      currentPlatform: currentHostPlatform() ?? 'unsupported',
      execute: async (chain, victim): Promise<DiagnosisExecutionResult<CompleteFilesystemDiff>> =>
        mapArmResult(
          await executeArm({
            manifest,
            predecessorCases: chain,
            seed: prepared.snapshot,
            signal: scope.signal,
            temporaryRoot,
            victimCase: victim,
          }),
        ),
      maxChainLength: manifest.definition.suite.search.maxChainLength,
      maxExperiments: manifest.definition.suite.search.maxExperiments,
      orderedCases: manifest.definition.cases,
      repetitions: manifest.definition.suite.repetitions,
      victims,
    });
    const aggregate = aggregateOutcome(diagnosis);
    const report = createReport({
      exitCode: aggregate.exitCode,
      experiments: {
        limit: diagnosis.experiments.limit,
        used: diagnosis.experiments.used,
      },
      schema: GHOSTCASE_REPORT_SCHEMA,
      status: aggregate.status,
      suite: {
        id: manifest.definition.suite.id,
        sourceSha256: manifest.sourceSha256,
      },
      toolVersion: VERSION,
      victims: diagnosis.victims.map(toVictimReport),
    });

    return Object.freeze({
      diagnosis,
      manifest,
      prepared,
      report,
    });
  } finally {
    scope.dispose();
  }
}

function selectVictims(
  cases: readonly CaseSpec[],
  requestedIds: readonly string[] | undefined,
): readonly CaseSpec[] {
  if (requestedIds === undefined) {
    return Object.freeze([...cases]);
  }
  const ids = [...requestedIds];
  if (ids.length === 0) {
    throw new ConfigError('Victim selection must contain at least one case ID.');
  }

  const byId = new Map(cases.map((caseSpec) => [caseSpec.id, caseSpec]));
  const seen = new Set<string>();
  const selected: CaseSpec[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ConfigError(`Victim selection contains duplicate case ID '${id}'.`);
    }
    seen.add(id);
    const caseSpec = byId.get(id);
    if (caseSpec === undefined) {
      throw new ConfigError(`Victim selection references unknown case ID '${id}'.`);
    }
    selected.push(caseSpec);
  }
  return Object.freeze(selected);
}

async function canonicalTemporaryRoot(requested: string | undefined): Promise<string> {
  try {
    return await realpath(requested ?? tmpdir());
  } catch (error) {
    throw new ConfigError('Temporary root could not be resolved to an existing directory.', {
      cause: error,
    });
  }
}

function mapArmResult(result: ExecuteArmResult): DiagnosisExecutionResult<CompleteFilesystemDiff> {
  if (result.status === 'invalid') {
    return Object.freeze({
      code: result.reason,
      kind: 'invalid',
      reason: safeInvalidReason(result.phase, result.reason),
    });
  }
  return Object.freeze({
    evidence: result.predecessorResidue,
    kind: 'valid',
    oracleOutcome: result.victim.outcome,
    semanticSignature: result.victim.semanticSignature,
  });
}

function safeInvalidReason(phase: InvalidArmPhase, reason: InvalidArmReason): string {
  return `ARM_${phase.toUpperCase()}_${reason}`;
}

function toVictimReport(
  diagnosis: VictimDiagnosis<CompleteFilesystemDiff>,
): GhostCaseVictimReportInput {
  const reason = safeReportReason(diagnosis);
  return {
    fresh: summarizeArm(diagnosis.fresh),
    id: diagnosis.victimId,
    minimalChain: diagnosis.minimalChainIds,
    minimality: diagnosis.minimality,
    ...(reason === undefined ? {} : { reason }),
    shared: summarizeArm(diagnosis.shared),
    stateChanges:
      diagnosis.representativeEvidence.shared?.changes.map(
        ({ alias, digest, kind, size, subjectId }) => ({
          alias,
          ...(digest === undefined ? {} : { digest }),
          kind,
          ...(size === undefined ? {} : { size }),
          subjectId,
        }),
      ) ?? [],
    verdict: diagnosis.verdict,
  };
}

function safeReportReason(diagnosis: VictimDiagnosis<CompleteFilesystemDiff>): string | undefined {
  switch (diagnosis.verdict) {
    case 'CLEAN':
      return undefined;
    case 'HIDDEN_DEPENDENCY':
    case 'OUTCOME_SHIFT':
    case 'POLLUTION':
      return 'stable_counterfactual_shift';
    case 'HARNESS_ERROR':
      return diagnosis.fresh.kind === 'harness_error'
        ? 'fresh_arm_harness_error'
        : 'shared_arm_harness_error';
    case 'NON_REPRODUCIBLE':
      return diagnosis.fresh.kind === 'non_reproducible'
        ? 'fresh_arm_non_reproducible'
        : 'shared_arm_non_reproducible';
    case 'INCONCLUSIVE':
      return diagnosis.fresh.kind === 'inconclusive'
        ? 'fresh_arm_inconclusive'
        : 'shared_arm_inconclusive';
  }
}

function aggregateOutcome(diagnosis: DiagnosisReport<CompleteFilesystemDiff>): AggregateOutcome {
  if (diagnosis.victims.some(({ verdict }) => verdict === 'HARNESS_ERROR')) {
    return { exitCode: 3, status: 'harness_error' };
  }
  if (
    diagnosis.victims.some(
      ({ verdict }) => verdict === 'INCONCLUSIVE' || verdict === 'NON_REPRODUCIBLE',
    )
  ) {
    return { exitCode: 3, status: 'inconclusive' };
  }
  if (
    diagnosis.victims.some(
      ({ verdict }) =>
        verdict === 'HIDDEN_DEPENDENCY' || verdict === 'OUTCOME_SHIFT' || verdict === 'POLLUTION',
    )
  ) {
    return { exitCode: 1, status: 'findings' };
  }
  return { exitCode: 0, status: 'clean' };
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
