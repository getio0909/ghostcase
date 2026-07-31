import type { CaseSpec, PlatformName } from '../domain/model.js';
import { currentHostPlatform } from '../platform/host.js';
import {
  deterministicDdmin,
  exactPrefixScan,
  type DdminResult,
  type PrefixSearchResult,
} from '../search/index.js';
import {
  createEvaluationBudget,
  evaluateStability,
  type EvaluationBudget,
  type MaybePromise,
  type SearchPredicateOutcome,
  type StabilityResult,
} from '../search/stability.js';
import { classifyArms, type ArmClassification, type FindingVerdict } from './verdict.js';

export interface ValidDiagnosisExecution<Evidence = unknown> {
  readonly evidence?: Evidence;
  readonly kind: 'valid';
  readonly oracleOutcome: 'fail' | 'pass';
  readonly semanticSignature: string;
}

export interface InvalidDiagnosisExecution {
  readonly code: string;
  readonly kind: 'invalid';
  readonly reason: string;
}

export type DiagnosisExecutionResult<Evidence = unknown> =
  InvalidDiagnosisExecution | ValidDiagnosisExecution<Evidence>;

export type DiagnosisExecutor<Evidence = unknown> = (
  chain: readonly CaseSpec[],
  victim: CaseSpec,
  attemptIndex: number,
) => MaybePromise<DiagnosisExecutionResult<Evidence>>;

export type DiagnosisPlatform = PlatformName | 'unsupported';

export interface DiagnoseCasesOptions<Evidence = unknown> {
  readonly currentPlatform?: DiagnosisPlatform;
  readonly execute: DiagnosisExecutor<Evidence>;
  readonly maxChainLength: number;
  readonly maxExperiments: number;
  readonly orderedCases: readonly CaseSpec[];
  readonly repetitions: number;
  readonly victims: readonly CaseSpec[];
}

export interface CandidateWindowSummary {
  readonly omittedCandidateIds: readonly string[];
  readonly originalCandidateCount: number;
  readonly platformExcludedCandidateIds: readonly string[];
  readonly selectedCandidateIds: readonly string[];
  readonly strategy: 'nearest_predecessors';
  readonly truncated: boolean;
}

export interface PrefixObservationSummary {
  readonly length: number;
  readonly outcome: SearchPredicateOutcome;
  readonly source: 'evaluated' | 'initial';
}

export interface PrefixDiagnosisSummary {
  readonly evaluationCount: number;
  readonly exact: boolean;
  readonly kind: 'found' | 'inconclusive' | 'not_found' | 'skipped';
  readonly observations: readonly PrefixObservationSummary[];
  readonly prefixLength: number | null;
  readonly reason: string | null;
}

export type Minimality = 'not_applicable' | 'proven' | 'unproven';

export interface DdminDiagnosisSummary {
  readonly candidateIds: readonly string[];
  readonly candidateOccurrenceIndices: readonly number[];
  readonly evaluationCount: number;
  readonly initialLength: number;
  readonly kind: 'inconclusive' | 'minimized' | 'not_failing' | 'partial';
  readonly minimality: Minimality;
  readonly reason: string | null;
  readonly unresolvedEvaluations: number;
}

export interface RepresentativeEvidence<Evidence = unknown> {
  readonly fresh: Evidence | null;
  readonly shared: Evidence | null;
}

export interface VictimDiagnosis<Evidence = unknown> {
  readonly candidateWindow: CandidateWindowSummary;
  readonly ddmin: DdminDiagnosisSummary | null;
  readonly diagnosticReasons: readonly string[];
  readonly fresh: ArmClassification;
  readonly minimalChainIds: readonly string[];
  readonly minimality: Minimality;
  readonly prefix: PrefixDiagnosisSummary;
  readonly representativeEvidence: RepresentativeEvidence<Evidence>;
  readonly shared: ArmClassification;
  readonly verdict: FindingVerdict;
  readonly victimId: string;
}

export interface DiagnosisReport<Evidence = unknown> {
  readonly experiments: {
    readonly limit: number;
    readonly remaining: number;
    readonly used: number;
  };
  readonly platform: DiagnosisPlatform;
  readonly victims: readonly VictimDiagnosis<Evidence>[];
}

interface ArmAssessment<Evidence> {
  readonly classification: ArmClassification;
  readonly representativeEvidence: Evidence | null;
}

interface DiagnosisContext<Evidence> {
  readonly budget: EvaluationBudget;
  readonly cache: Map<string, Promise<ArmAssessment<Evidence>>>;
  readonly execute: DiagnosisExecutor<Evidence>;
  readonly opaqueEvidence: WeakSet<object>;
  readonly repetitions: number;
}

interface CandidateWindow {
  readonly selected: readonly CaseSpec[];
  readonly summary: CandidateWindowSummary;
}

export async function diagnoseCases<Evidence = unknown>(
  rawOptions: DiagnoseCasesOptions<Evidence>,
): Promise<DiagnosisReport<Evidence>> {
  validateOptions(rawOptions);

  const platform = rawOptions.currentPlatform ?? currentHostPlatform() ?? 'unsupported';
  const orderedCases = rawOptions.orderedCases.map((caseSpec) =>
    deepFreeze(structuredClone(caseSpec)),
  );
  const byId = new Map(orderedCases.map((caseSpec) => [caseSpec.id, caseSpec]));
  const victims = rawOptions.victims.map((victim) => {
    const resolved = byId.get(victim.id);
    if (resolved === undefined) {
      throw new Error(`Validated victim disappeared from case index: ${victim.id}`);
    }
    return resolved;
  });
  const budget = createEvaluationBudget(rawOptions.maxExperiments);
  const opaqueEvidence = new WeakSet<object>();
  const context: DiagnosisContext<Evidence> = {
    budget,
    cache: new Map(),
    execute: rawOptions.execute,
    opaqueEvidence,
    repetitions: rawOptions.repetitions,
  };

  const victimDiagnoses: VictimDiagnosis<Evidence>[] = [];
  for (const victim of victims) {
    const victimIndex = orderedCases.findIndex(({ id }) => id === victim.id);
    const candidateWindow = selectCandidateWindow(
      orderedCases,
      victim,
      victimIndex,
      platform,
      rawOptions.maxChainLength,
    );
    victimDiagnoses.push(await diagnoseVictim(victim, candidateWindow, platform, context));
  }

  return deepFreeze(
    {
      experiments: {
        limit: budget.limit,
        remaining: budget.remaining,
        used: budget.used,
      },
      platform,
      victims: victimDiagnoses,
    },
    new WeakSet(),
    opaqueEvidence,
  );
}

async function diagnoseVictim<Evidence>(
  victim: CaseSpec,
  candidateWindow: CandidateWindow,
  platform: DiagnosisPlatform,
  context: DiagnosisContext<Evidence>,
): Promise<VictimDiagnosis<Evidence>> {
  const diagnosticReasons = candidateWindow.summary.truncated
    ? ['candidate_window_truncated_to_nearest_predecessors']
    : [];

  if (!supportsPlatform(victim, platform)) {
    const classification: ArmClassification = deepFreeze({
      kind: 'inconclusive',
      reason: `victim_not_applicable_to_${platform}`,
    });
    return {
      candidateWindow: candidateWindow.summary,
      ddmin: null,
      diagnosticReasons,
      fresh: classification,
      minimalChainIds: [],
      minimality: 'not_applicable',
      prefix: skippedPrefix('victim_not_applicable_to_platform'),
      representativeEvidence: { fresh: null, shared: null },
      shared: classification,
      verdict: 'INCONCLUSIVE',
      victimId: victim.id,
    };
  }

  const fresh = await assessArm([], victim, context);
  if (fresh.classification.kind !== 'stable') {
    return {
      candidateWindow: candidateWindow.summary,
      ddmin: null,
      diagnosticReasons,
      fresh: fresh.classification,
      minimalChainIds: [],
      minimality: 'not_applicable',
      prefix: skippedPrefix('fresh_arm_not_stable'),
      representativeEvidence: {
        fresh: fresh.representativeEvidence,
        shared: null,
      },
      shared: fresh.classification,
      verdict: classifyArms(fresh.classification, fresh.classification),
      victimId: victim.id,
    };
  }

  const predicate = async (chain: readonly CaseSpec[]): Promise<SearchPredicateOutcome> => {
    const shared = await assessArm(chain, victim, context);
    return verdictToPredicate(classifyArms(fresh.classification, shared.classification));
  };
  const prefixResult = await exactPrefixScan(candidateWindow.selected, predicate);
  const prefix = summarizePrefix(prefixResult);

  if (prefixResult.kind === 'not_found') {
    const shared =
      candidateWindow.selected.length === 0
        ? fresh
        : await assessArm(candidateWindow.selected, victim, context);
    const sharedClassification: ArmClassification = candidateWindow.summary.truncated
      ? deepFreeze({
          kind: 'inconclusive',
          reason: 'candidate_window_truncated_before_any_shift_was_found',
        })
      : shared.classification;
    return {
      candidateWindow: candidateWindow.summary,
      ddmin: null,
      diagnosticReasons,
      fresh: fresh.classification,
      minimalChainIds: [],
      minimality: 'not_applicable',
      prefix,
      representativeEvidence: evidencePair(fresh, shared),
      shared: sharedClassification,
      verdict: classifyArms(fresh.classification, sharedClassification),
      victimId: victim.id,
    };
  }

  if (prefixResult.kind === 'inconclusive') {
    const unresolvedChain =
      prefixResult.unresolvedLength === undefined
        ? []
        : candidateWindow.selected.slice(0, prefixResult.unresolvedLength);
    const shared =
      unresolvedChain.length === 0 ? fresh : await assessArm(unresolvedChain, victim, context);
    return {
      candidateWindow: candidateWindow.summary,
      ddmin: null,
      diagnosticReasons,
      fresh: fresh.classification,
      minimalChainIds: [],
      minimality: 'not_applicable',
      prefix,
      representativeEvidence: evidencePair(fresh, shared),
      shared: shared.classification,
      verdict: classifyArms(fresh.classification, shared.classification),
      victimId: victim.id,
    };
  }

  const ddminResult = await deterministicDdmin(prefixResult.prefix, predicate);
  const minimizedChain = chooseMinimizedChain(prefixResult.prefix, ddminResult);
  const shared = await assessArm(minimizedChain, victim, context);
  return {
    candidateWindow: candidateWindow.summary,
    ddmin: summarizeDdmin(ddminResult),
    diagnosticReasons,
    fresh: fresh.classification,
    minimalChainIds: minimizedChain.map(({ id }) => id),
    minimality: ddminResult.localMinimality,
    prefix,
    representativeEvidence: evidencePair(fresh, shared),
    shared: shared.classification,
    verdict: classifyArms(fresh.classification, shared.classification),
    victimId: victim.id,
  };
}

function selectCandidateWindow(
  orderedCases: readonly CaseSpec[],
  victim: CaseSpec,
  victimIndex: number,
  platform: DiagnosisPlatform,
  maxChainLength: number,
): CandidateWindow {
  const preceding = orderedCases
    .slice(0, victimIndex)
    .filter((candidate) => candidate.id !== victim.id);
  const eligible = preceding.filter((candidate) => supportsPlatform(candidate, platform));
  const platformExcluded = preceding.filter((candidate) => !supportsPlatform(candidate, platform));
  const omittedCount = Math.max(0, eligible.length - maxChainLength);
  const selected =
    maxChainLength === 0 ? [] : eligible.slice(Math.max(0, eligible.length - maxChainLength));
  const omitted = eligible.slice(0, omittedCount);

  return {
    selected: Object.freeze(selected),
    summary: deepFreeze({
      omittedCandidateIds: omitted.map(({ id }) => id),
      originalCandidateCount: eligible.length,
      platformExcludedCandidateIds: platformExcluded.map(({ id }) => id),
      selectedCandidateIds: selected.map(({ id }) => id),
      strategy: 'nearest_predecessors' as const,
      truncated: omitted.length > 0,
    }),
  };
}

function supportsPlatform(caseSpec: CaseSpec, platform: DiagnosisPlatform): boolean {
  return platform !== 'unsupported' && caseSpec.platforms.includes(platform);
}

async function assessArm<Evidence>(
  chain: readonly CaseSpec[],
  victim: CaseSpec,
  context: DiagnosisContext<Evidence>,
): Promise<ArmAssessment<Evidence>> {
  const key = JSON.stringify([victim.id, ...chain.map(({ id }) => id)]);
  const cached = context.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const chainSnapshot = Object.freeze([...chain]);
  const pending = evaluateStability<ValidDiagnosisExecution<Evidence>, InvalidDiagnosisExecution>(
    async (attemptIndex) => {
      const execution = await safelyExecute(context.execute, chainSnapshot, victim, attemptIndex);
      if (execution.kind === 'invalid') {
        return { kind: 'invalid', reason: execution };
      }
      return {
        kind: 'valid',
        signature: JSON.stringify([execution.oracleOutcome, execution.semanticSignature]),
        value: execution,
      };
    },
    {
      budget: context.budget,
      maxAttempts: context.repetitions,
      requiredValidRuns: context.repetitions,
    },
  ).then((stability) => classifyStability(stability, context.opaqueEvidence));

  context.cache.set(key, pending);
  return pending;
}

async function safelyExecute<Evidence>(
  execute: DiagnosisExecutor<Evidence>,
  chain: readonly CaseSpec[],
  victim: CaseSpec,
  attemptIndex: number,
): Promise<DiagnosisExecutionResult<Evidence>> {
  let raw: unknown;
  try {
    raw = await execute(chain, victim, attemptIndex);
  } catch {
    return {
      code: 'EXECUTOR_THROWN',
      kind: 'invalid',
      reason: 'executor threw',
    };
  }
  return normalizeExecution<Evidence>(raw);
}

function normalizeExecution<Evidence>(raw: unknown): DiagnosisExecutionResult<Evidence> {
  if (raw === null || typeof raw !== 'object') {
    return malformedExecution();
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'valid') {
    if (
      (candidate.oracleOutcome !== 'fail' && candidate.oracleOutcome !== 'pass') ||
      typeof candidate.semanticSignature !== 'string' ||
      candidate.semanticSignature.trim().length === 0
    ) {
      return malformedExecution();
    }
    const oracleOutcome: 'fail' | 'pass' = candidate.oracleOutcome;
    const semanticSignature: string = candidate.semanticSignature;
    const normalized: ValidDiagnosisExecution<Evidence> = {
      kind: 'valid' as const,
      oracleOutcome,
      semanticSignature,
    };
    return Object.hasOwn(candidate, 'evidence')
      ? { ...normalized, evidence: candidate.evidence as Evidence }
      : normalized;
  }
  if (
    candidate.kind !== 'invalid' ||
    typeof candidate.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate.code) ||
    typeof candidate.reason !== 'string' ||
    candidate.reason.trim().length === 0 ||
    candidate.reason.length > 512 ||
    hasUnsafeControlCharacter(candidate.reason)
  ) {
    return malformedExecution();
  }
  return {
    code: candidate.code,
    kind: 'invalid',
    reason: candidate.reason,
  };
}

function malformedExecution(): InvalidDiagnosisExecution {
  return {
    code: 'INVALID_EXECUTION_RESULT',
    kind: 'invalid',
    reason: 'executor returned an invalid result',
  };
}

function classifyStability<Evidence>(
  stability: StabilityResult<ValidDiagnosisExecution<Evidence>, InvalidDiagnosisExecution>,
  opaqueEvidence: WeakSet<object>,
): ArmAssessment<Evidence> {
  const representativeEvidence = firstEvidence(stability, opaqueEvidence);
  if (stability.kind === 'stable') {
    const representative = stability.validValues[0];
    if (representative === undefined) {
      throw new Error('Stable result did not contain a representative value');
    }
    return {
      classification: deepFreeze({
        kind: 'stable',
        oracleOutcome: representative.oracleOutcome,
        signature: representative.semanticSignature,
      }),
      representativeEvidence,
    };
  }
  if (stability.kind === 'non_reproducible') {
    return {
      classification: deepFreeze({ kind: 'non_reproducible' }),
      representativeEvidence,
    };
  }

  const invalidAttempts = stability.attempts
    .filter((attempt) => attempt.kind === 'invalid')
    .map(({ reason }) => reason);
  if (stability.validRuns === 0 && invalidAttempts.length > 0) {
    const firstInvalid = invalidAttempts[0];
    if (firstInvalid === undefined) {
      throw new Error('Invalid-attempt count was inconsistent');
    }
    return {
      classification: deepFreeze({
        kind: 'harness_error',
        reason: `${firstInvalid.code}: ${firstInvalid.reason}`,
      }),
      representativeEvidence,
    };
  }

  const reason =
    stability.reason === 'budget_exhausted'
      ? `budget_exhausted_after_${String(stability.validRuns)}_valid_runs`
      : `attempt_limit_after_${String(stability.validRuns)}_valid_runs`;
  return {
    classification: deepFreeze({ kind: 'inconclusive', reason }),
    representativeEvidence,
  };
}

function firstEvidence<Evidence>(
  stability: StabilityResult<ValidDiagnosisExecution<Evidence>, InvalidDiagnosisExecution>,
  opaqueEvidence: WeakSet<object>,
): Evidence | null {
  for (const attempt of stability.attempts) {
    if (
      attempt.kind === 'valid' &&
      Object.hasOwn(attempt.value, 'evidence') &&
      attempt.value.evidence !== undefined
    ) {
      return cloneEvidence(attempt.value.evidence, opaqueEvidence);
    }
  }
  return null;
}

function cloneEvidence<Evidence>(evidence: Evidence, opaqueEvidence: WeakSet<object>): Evidence {
  try {
    return structuredClone(evidence);
  } catch {
    if ((typeof evidence === 'object' && evidence !== null) || typeof evidence === 'function') {
      opaqueEvidence.add(evidence);
    }
    return evidence;
  }
}

function verdictToPredicate(verdict: FindingVerdict): SearchPredicateOutcome {
  switch (verdict) {
    case 'CLEAN':
      return 'NOT_FAIL';
    case 'HIDDEN_DEPENDENCY':
    case 'OUTCOME_SHIFT':
    case 'POLLUTION':
      return 'FAIL';
    case 'HARNESS_ERROR':
    case 'INCONCLUSIVE':
    case 'NON_REPRODUCIBLE':
      return 'UNRESOLVED';
  }
}

function chooseMinimizedChain<T>(prefix: readonly T[], ddmin: DdminResult<T>): readonly T[] {
  return ddmin.kind === 'inconclusive' || ddmin.kind === 'not_failing'
    ? Object.freeze([...prefix])
    : ddmin.candidate;
}

function summarizePrefix<T>(result: PrefixSearchResult<T>): PrefixDiagnosisSummary {
  const base = {
    evaluationCount: result.evaluationCount,
    exact: result.exact,
    observations: result.observations.map(({ length, outcome, source }) => ({
      length,
      outcome,
      source,
    })),
  };
  switch (result.kind) {
    case 'found':
      return {
        ...base,
        kind: 'found',
        prefixLength: result.prefixLength,
        reason: null,
      };
    case 'inconclusive':
      return {
        ...base,
        kind: 'inconclusive',
        prefixLength: result.unresolvedLength ?? null,
        reason: result.reason,
      };
    case 'not_found':
      return {
        ...base,
        kind: 'not_found',
        prefixLength: null,
        reason: null,
      };
  }
}

function skippedPrefix(reason: string): PrefixDiagnosisSummary {
  return deepFreeze({
    evaluationCount: 0,
    exact: false,
    kind: 'skipped',
    observations: [],
    prefixLength: null,
    reason,
  });
}

function summarizeDdmin<T extends CaseSpec>(result: DdminResult<T>): DdminDiagnosisSummary {
  return {
    candidateIds: result.candidate.map(({ id }) => id),
    candidateOccurrenceIndices: result.candidateOccurrenceIndices,
    evaluationCount: result.evaluationCount,
    initialLength: result.initialLength,
    kind: result.kind,
    minimality: result.localMinimality,
    reason: 'reason' in result ? result.reason : null,
    unresolvedEvaluations: result.unresolvedEvaluations,
  };
}

function evidencePair<Evidence>(
  fresh: ArmAssessment<Evidence>,
  shared: ArmAssessment<Evidence>,
): RepresentativeEvidence<Evidence> {
  return {
    fresh: fresh.representativeEvidence,
    shared: shared.representativeEvidence,
  };
}

function validateOptions(options: unknown): asserts options is DiagnoseCasesOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  const candidate = options as Record<string, unknown>;
  if (!Array.isArray(candidate.orderedCases)) {
    throw new TypeError('orderedCases must be an array');
  }
  if (!Array.isArray(candidate.victims)) {
    throw new TypeError('victims must be an array');
  }
  if (typeof candidate.execute !== 'function') {
    throw new TypeError('execute must be a function');
  }
  assertPositiveInteger(candidate.repetitions, 'repetitions');
  assertNonNegativeInteger(candidate.maxChainLength, 'maxChainLength');
  assertNonNegativeInteger(candidate.maxExperiments, 'maxExperiments');
  if (
    candidate.currentPlatform !== undefined &&
    candidate.currentPlatform !== 'linux' &&
    candidate.currentPlatform !== 'win32' &&
    candidate.currentPlatform !== 'unsupported'
  ) {
    throw new TypeError('currentPlatform must be linux, win32, or unsupported');
  }

  const caseIds = new Set<string>();
  for (const caseSpec of candidate.orderedCases) {
    assertCaseIdentity(caseSpec, 'orderedCases');
    if (caseIds.has(caseSpec.id)) {
      throw new TypeError(`orderedCases contains duplicate case id: ${caseSpec.id}`);
    }
    caseIds.add(caseSpec.id);
  }

  const victimIds = new Set<string>();
  for (const victim of candidate.victims) {
    assertCaseIdentity(victim, 'victims');
    if (!caseIds.has(victim.id)) {
      throw new TypeError(`victim is not present in orderedCases: ${victim.id}`);
    }
    if (victimIds.has(victim.id)) {
      throw new TypeError(`victims contains duplicate case id: ${victim.id}`);
    }
    victimIds.add(victim.id);
  }
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

function assertCaseIdentity(value: unknown, source: string): asserts value is CaseSpec {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).id !== 'string' ||
    ((value as Record<string, unknown>).id as string).trim().length === 0
  ) {
    throw new TypeError(`${source} must contain CaseSpec objects with non-empty ids`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>(), opaque = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  const object = value as object;
  if (opaque.has(object) || seen.has(object)) {
    return value;
  }
  seen.add(object);

  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      deepFreeze(descriptor.value, seen, opaque);
    }
  }
  return Object.freeze(value);
}
