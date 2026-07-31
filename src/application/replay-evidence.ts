import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EvidenceError } from '../domain/errors.js';
import type { CaseSpec, LoadedManifest, PlatformName } from '../domain/model.js';
import { loadEvidence } from '../evidence/index.js';
import {
  classifyArms,
  executeArm,
  type ArmClassification,
  type ExecuteArmResult,
  type FindingVerdict,
} from '../experiment/index.js';
import { currentHostPlatform } from '../platform/host.js';
import {
  createReport,
  GHOSTCASE_REPORT_SCHEMA,
  summarizeArm,
  type GhostCaseReport,
  type GhostCaseVictimReport,
  type GhostCaseVictimReportInput,
  type ReportArmSummary,
  type ReportExitCode,
  type ReportStateChangeInput,
  type ReportStatus,
} from '../report/index.js';
import { evaluateStability, type StabilityAttempt, type StabilityResult } from '../search/index.js';
import type { CompleteFilesystemDiff } from '../snapshot/index.js';
import { version as VERSION } from '../version.js';
import type { PreparedSuite } from '../workspace/index.js';

const MAX_REPORT_EXPERIMENTS = 4096;

export interface ReplayEvidenceOptions {
  readonly signal?: AbortSignal;
  readonly temporaryRoot?: string;
}

export interface ReplayEvidenceResult {
  readonly expectedReport: GhostCaseReport;
  readonly matched: boolean;
  readonly report: GhostCaseReport;
}

interface AbortScope {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

interface ReplayContext {
  readonly manifest: LoadedManifest;
  readonly prepared: PreparedSuite;
  readonly repetitions: number;
  readonly signal: AbortSignal;
  readonly temporaryRoot: string;
}

interface ValidReplayAttempt {
  readonly evidence: CompleteFilesystemDiff;
  readonly oracleOutcome: 'fail' | 'pass';
  readonly semanticSignature: string;
}

interface InvalidReplayAttempt {
  readonly code: string;
}

interface ReplayArmAssessment {
  readonly classification: ArmClassification;
  readonly representativeEvidence: CompleteFilesystemDiff | null;
}

interface ReplayVictimResult {
  readonly input: GhostCaseVictimReportInput;
  readonly matched: boolean;
}

interface AggregateOutcome {
  readonly exitCode: ReportExitCode;
  readonly status: ReportStatus;
}

interface IndexedCase {
  readonly caseSpec: CaseSpec;
  readonly index: number;
}

export async function replayEvidence(
  evidencePath: string,
  options: ReplayEvidenceOptions = {},
): Promise<ReplayEvidenceResult> {
  const loaded = await loadEvidence(evidencePath);
  const expectedReport = loaded.evidence.report;
  const caseIndex = validateRecordedCases(expectedReport, loaded.manifest);
  const repetitions = loaded.manifest.definition.suite.repetitions;
  const experimentLimit = expectedReport.victims.length * repetitions * 2;
  if (experimentLimit > MAX_REPORT_EXPERIMENTS) {
    throw new EvidenceError(
      'Recorded witnesses require more replay arms than the report format permits.',
    );
  }

  const scope = createAbortScope(
    options.signal,
    loaded.manifest.definition.execution.suiteTimeoutMs,
  );
  let experimentsUsed = 0;
  try {
    const [prepared, temporaryRoot] = await Promise.all([
      Promise.resolve(loaded.prepared),
      canonicalTemporaryRoot(options.temporaryRoot),
    ]);
    const context: ReplayContext = {
      manifest: loaded.manifest,
      prepared,
      repetitions,
      signal: scope.signal,
      temporaryRoot,
    };
    const victims: ReplayVictimResult[] = [];
    const platform = currentHostPlatform();

    for (const expected of expectedReport.victims) {
      const victim = requiredCase(caseIndex, expected.id, 'victim').caseSpec;
      const chain = expected.minimalChain.map(
        (id) => requiredCase(caseIndex, id, 'witness chain').caseSpec,
      );
      const unsupportedRole = unsupportedPlatformRole(victim, chain, platform);
      if (unsupportedRole !== undefined) {
        victims.push(platformInconclusive(expected, unsupportedRole));
        continue;
      }
      const fresh = await assessArm([], victim, context, () => {
        experimentsUsed += 1;
      });
      const shared = await assessArm(chain, victim, context, () => {
        experimentsUsed += 1;
      });
      victims.push(toReplayVictim(expected, fresh, shared));
    }

    const aggregate = aggregateOutcome(victims.map(({ input }) => input.verdict));
    const report = createReport({
      exitCode: aggregate.exitCode,
      experiments: {
        limit: Math.max(1, experimentLimit),
        used: experimentsUsed,
      },
      schema: GHOSTCASE_REPORT_SCHEMA,
      status: aggregate.status,
      suite: {
        id: loaded.manifest.definition.suite.id,
        sourceSha256: loaded.manifest.sourceSha256,
      },
      toolVersion: VERSION,
      victims: victims.map(({ input }) => input),
    });

    return Object.freeze({
      expectedReport,
      matched: victims.every(({ matched }) => matched),
      report,
    });
  } finally {
    scope.dispose();
  }
}

async function assessArm(
  chain: readonly CaseSpec[],
  victim: CaseSpec,
  context: ReplayContext,
  onExecute: () => void,
): Promise<ReplayArmAssessment> {
  const stability = await evaluateStability<ValidReplayAttempt, InvalidReplayAttempt>(
    async (): Promise<StabilityAttempt<ValidReplayAttempt, InvalidReplayAttempt>> => {
      onExecute();
      let result: ExecuteArmResult;
      try {
        result = await executeArm({
          manifest: context.manifest,
          predecessorCases: chain,
          seed: context.prepared.snapshot,
          signal: context.signal,
          temporaryRoot: context.temporaryRoot,
          victimCase: victim,
        });
      } catch {
        return {
          kind: 'invalid',
          reason: { code: 'EXECUTOR_THROWN' },
        };
      }
      if (result.status === 'invalid') {
        return {
          kind: 'invalid',
          reason: { code: result.reason },
        };
      }
      const value: ValidReplayAttempt = Object.freeze({
        evidence: result.predecessorResidue,
        oracleOutcome: result.victim.outcome,
        semanticSignature: result.victim.semanticSignature,
      });
      return {
        kind: 'valid',
        signature: JSON.stringify([value.oracleOutcome, value.semanticSignature]),
        value,
      };
    },
    {
      maxAttempts: context.repetitions,
      requiredValidRuns: context.repetitions,
    },
  );
  return classifyStability(stability);
}

function classifyStability(
  stability: StabilityResult<ValidReplayAttempt, InvalidReplayAttempt>,
): ReplayArmAssessment {
  const representativeEvidence = firstEvidence(stability);
  if (stability.kind === 'stable') {
    const representative = stability.validValues[0];
    if (representative === undefined) {
      throw new EvidenceError('Stable replay arm did not retain a representative result.');
    }
    return Object.freeze({
      classification: Object.freeze({
        kind: 'stable',
        oracleOutcome: representative.oracleOutcome,
        signature: representative.semanticSignature,
      }),
      representativeEvidence,
    });
  }
  if (stability.kind === 'non_reproducible') {
    return Object.freeze({
      classification: Object.freeze({ kind: 'non_reproducible' }),
      representativeEvidence,
    });
  }
  let firstInvalidCode: string | undefined;
  for (const attempt of stability.attempts) {
    if (attempt.kind === 'invalid') {
      firstInvalidCode = attempt.reason.code;
      break;
    }
  }
  if (stability.validRuns === 0 && firstInvalidCode !== undefined) {
    return Object.freeze({
      classification: Object.freeze({
        kind: 'harness_error',
        reason: firstInvalidCode,
      }),
      representativeEvidence,
    });
  }
  return Object.freeze({
    classification: Object.freeze({
      kind: 'inconclusive',
      reason: `attempt_limit_after_${String(stability.validRuns)}_valid_runs`,
    }),
    representativeEvidence,
  });
}

function firstEvidence(
  stability: StabilityResult<ValidReplayAttempt, InvalidReplayAttempt>,
): CompleteFilesystemDiff | null {
  for (const attempt of stability.attempts) {
    if (attempt.kind === 'valid') {
      return attempt.value.evidence;
    }
  }
  return null;
}

function toReplayVictim(
  expected: GhostCaseVictimReport,
  fresh: ReplayArmAssessment,
  shared: ReplayArmAssessment,
): ReplayVictimResult {
  let currentFresh = fresh.classification;
  let currentShared = shared.classification;
  let verdict = classifyArms(currentFresh, currentShared);

  if (isFinding(verdict) && expected.minimalChain.length === 0) {
    currentFresh = Object.freeze({ kind: 'non_reproducible' });
    currentShared = currentFresh;
    verdict = 'NON_REPRODUCIBLE';
  }

  const freshSummary = summarizeArm(currentFresh);
  const sharedSummary = summarizeArm(currentShared);
  const keepChain = isFinding(verdict);
  const minimalChain = keepChain ? expected.minimalChain : [];
  const minimality = keepChain ? expected.minimality : 'not_applicable';
  const reason =
    verdict === expected.verdict
      ? undefined
      : `expected_${expected.verdict.toLowerCase()}_observed_${verdict.toLowerCase()}`;
  const stateChanges: readonly ReportStateChangeInput[] =
    shared.representativeEvidence?.changes.map(({ alias, digest, kind, size, subjectId }) => ({
      alias,
      ...(digest === undefined ? {} : { digest }),
      kind,
      ...(size === undefined ? {} : { size }),
      subjectId,
    })) ?? [];
  const input: GhostCaseVictimReportInput = {
    fresh: freshSummary,
    id: expected.id,
    minimalChain,
    minimality,
    ...(reason === undefined ? {} : { reason }),
    shared: sharedSummary,
    stateChanges,
    verdict,
  };

  return Object.freeze({
    input,
    matched:
      verdict === expected.verdict &&
      armSummaryEquals(freshSummary, expected.fresh) &&
      armSummaryEquals(sharedSummary, expected.shared) &&
      stringArraysEqual(minimalChain, expected.minimalChain) &&
      stateChangesEqual(stateChanges, expected.stateChanges),
  });
}

function validateRecordedCases(
  report: GhostCaseReport,
  manifest: LoadedManifest,
): ReadonlyMap<string, IndexedCase> {
  const caseIndex = new Map(
    manifest.definition.cases.map((caseSpec, index) => [
      caseSpec.id,
      Object.freeze({ caseSpec, index }),
    ]),
  );
  for (const victim of report.victims) {
    const indexedVictim = requiredCase(caseIndex, victim.id, 'victim');
    let previousIndex = -1;
    for (const id of victim.minimalChain) {
      const predecessor = requiredCase(caseIndex, id, 'witness chain');
      if (predecessor.index >= indexedVictim.index) {
        throw new EvidenceError(
          `Recorded witness chain case '${id}' must occur before victim '${victim.id}'.`,
        );
      }
      if (predecessor.index <= previousIndex) {
        throw new EvidenceError(
          `Recorded witness chain for victim '${victim.id}' must follow increasing suite order.`,
        );
      }
      previousIndex = predecessor.index;
    }
  }
  return caseIndex;
}

function requiredCase(
  caseIndex: ReadonlyMap<string, IndexedCase>,
  id: string,
  role: string,
): IndexedCase {
  const indexed = caseIndex.get(id);
  if (indexed === undefined) {
    throw new EvidenceError(`Recorded ${role} references unknown case ID '${id}'.`);
  }
  return indexed;
}

function armSummaryEquals(left: ReportArmSummary, right: ReportArmSummary): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind !== 'stable' || right.kind !== 'stable') {
    return true;
  }
  return (
    left.oracleOutcome === right.oracleOutcome && left.signatureSha256 === right.signatureSha256
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stateChangesEqual(
  left: readonly ReportStateChangeInput[],
  right: readonly ReportStateChangeInput[],
): boolean {
  return (
    left.length === right.length &&
    left.every((change, index) => {
      const expected = right[index];
      return (
        change.alias === expected?.alias &&
        change.kind === expected.kind &&
        change.subjectId === expected.subjectId &&
        change.digest === expected.digest &&
        change.size === expected.size
      );
    })
  );
}

function unsupportedPlatformRole(
  victim: CaseSpec,
  chain: readonly CaseSpec[],
  platform: PlatformName | undefined,
): 'chain' | 'host' | 'victim' | undefined {
  if (platform === undefined) {
    return 'host';
  }
  if (!victim.platforms.includes(platform)) {
    return 'victim';
  }
  return chain.some((caseSpec) => !caseSpec.platforms.includes(platform)) ? 'chain' : undefined;
}

function platformInconclusive(
  expected: GhostCaseVictimReport,
  role: 'chain' | 'host' | 'victim',
): ReplayVictimResult {
  const incomplete = Object.freeze({ kind: 'inconclusive' as const });
  const input: GhostCaseVictimReportInput = {
    fresh: incomplete,
    id: expected.id,
    minimalChain: [],
    minimality: 'not_applicable',
    reason: `recorded_${role}_platform_not_supported`,
    shared: incomplete,
    stateChanges: [],
    verdict: 'INCONCLUSIVE',
  };
  return Object.freeze({
    input,
    matched: false,
  });
}

function isFinding(verdict: FindingVerdict): boolean {
  return verdict === 'HIDDEN_DEPENDENCY' || verdict === 'OUTCOME_SHIFT' || verdict === 'POLLUTION';
}

function aggregateOutcome(verdicts: readonly FindingVerdict[]): AggregateOutcome {
  if (verdicts.includes('HARNESS_ERROR')) {
    return { exitCode: 3, status: 'harness_error' };
  }
  if (verdicts.includes('INCONCLUSIVE') || verdicts.includes('NON_REPRODUCIBLE')) {
    return { exitCode: 3, status: 'inconclusive' };
  }
  if (verdicts.some(isFinding)) {
    return { exitCode: 1, status: 'findings' };
  }
  return { exitCode: 0, status: 'clean' };
}

async function canonicalTemporaryRoot(requested: string | undefined): Promise<string> {
  try {
    return await realpath(requested ?? tmpdir());
  } catch (error) {
    throw new EvidenceError('Replay temporary root could not be resolved.', {
      cause: error,
    });
  }
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
