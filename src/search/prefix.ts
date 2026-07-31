import {
  assertSearchPredicateOutcome,
  type EvaluationBudget,
  type MaybePromise,
  type SearchPredicateOutcome,
} from './stability.js';

export type SearchPredicate<T> = (candidate: readonly T[]) => MaybePromise<SearchPredicateOutcome>;

export interface KnownPrefixObservation {
  readonly length: number;
  readonly outcome: SearchPredicateOutcome;
}

export interface PrefixObservation extends KnownPrefixObservation {
  readonly source: 'evaluated' | 'initial';
}

export interface PrefixSearchOptions {
  readonly budget?: EvaluationBudget;
  readonly initialObservations?: readonly KnownPrefixObservation[];
}

type PrefixMode = 'exact' | 'fast';
type Monotonicity = 'not_required' | 'not_established' | 'violated';

interface PrefixResultBase {
  readonly exact: boolean;
  readonly requestedMode: PrefixMode;
  readonly completedMode: PrefixMode;
  readonly monotonicity: Monotonicity;
  readonly usedFallback: boolean;
  readonly observations: readonly PrefixObservation[];
  readonly evaluationCount: number;
}

export interface FoundPrefixResult<T> extends PrefixResultBase {
  readonly kind: 'found';
  readonly prefix: readonly T[];
  readonly prefixLength: number;
}

export interface PrefixNotFoundResult extends PrefixResultBase {
  readonly kind: 'not_found';
}

export interface InconclusivePrefixResult extends PrefixResultBase {
  readonly kind: 'inconclusive';
  readonly reason:
    'budget_exhausted' | 'empty_prefix_fails' | 'full_prefix_not_failing' | 'predicate_unresolved';
  readonly unresolvedLength?: number;
}

export type PrefixSearchResult<T> =
  FoundPrefixResult<T> | PrefixNotFoundResult | InconclusivePrefixResult;

export class PrefixPredicateError extends Error {
  constructor(prefixLength: number, cause: unknown) {
    super(`Prefix predicate threw for length ${String(prefixLength)}`, {
      cause,
    });
    this.name = 'PrefixPredicateError';
  }
}

interface ResultMetadata {
  readonly requestedMode: PrefixMode;
  readonly completedMode: PrefixMode;
  readonly monotonicity: Monotonicity;
  readonly usedFallback: boolean;
}

type EvaluationResult =
  | { readonly kind: 'outcome'; readonly outcome: SearchPredicateOutcome }
  | { readonly kind: 'budget_exhausted' };

class PrefixEvaluator<T> {
  readonly #sequence: readonly T[];
  readonly #predicate: SearchPredicate<T>;
  readonly #budget: EvaluationBudget | undefined;
  readonly #observations = new Map<number, PrefixObservation>();
  #evaluationCount = 0;

  constructor(sequence: readonly T[], predicate: SearchPredicate<T>, options: PrefixSearchOptions) {
    this.#sequence = Object.freeze([...sequence]);
    this.#predicate = predicate;
    this.#budget = options.budget;

    for (const rawObservation of options.initialObservations ?? []) {
      assertKnownPrefixObservation(rawObservation, sequence.length);
      const observation = rawObservation;
      const existing = this.#observations.get(observation.length);
      if (existing !== undefined && existing.outcome !== observation.outcome) {
        throw new TypeError(
          `Conflicting initial observations for prefix length ${String(observation.length)}`,
        );
      }
      if (existing === undefined) {
        this.#observations.set(
          observation.length,
          Object.freeze({
            length: observation.length,
            outcome: observation.outcome,
            source: 'initial',
          }),
        );
      }
    }
  }

  get evaluationCount(): number {
    return this.#evaluationCount;
  }

  get observations(): readonly PrefixObservation[] {
    return Object.freeze(
      [...this.#observations.values()].sort((left, right) => left.length - right.length),
    );
  }

  get length(): number {
    return this.#sequence.length;
  }

  prefix(length: number): readonly T[] {
    assertPrefixLength(length, this.#sequence.length);
    return Object.freeze(this.#sequence.slice(0, length));
  }

  hasObservedMonotonicityViolation(): boolean {
    const observations = this.observations;
    for (const left of observations) {
      if (left.outcome !== 'FAIL') {
        continue;
      }
      for (const right of observations) {
        if (right.length > left.length && right.outcome === 'NOT_FAIL') {
          return true;
        }
      }
    }
    return false;
  }

  async evaluate(length: number): Promise<EvaluationResult> {
    assertPrefixLength(length, this.#sequence.length);
    const existing = this.#observations.get(length);
    if (existing !== undefined) {
      return { kind: 'outcome', outcome: existing.outcome };
    }

    if (this.#budget !== undefined && !this.#budget.tryConsume()) {
      return { kind: 'budget_exhausted' };
    }

    let outcome: SearchPredicateOutcome;
    try {
      outcome = await this.#predicate(this.prefix(length));
    } catch (error) {
      throw new PrefixPredicateError(length, error);
    }
    assertSearchPredicateOutcome(outcome);
    this.#evaluationCount += 1;
    this.#observations.set(length, Object.freeze({ length, outcome, source: 'evaluated' }));
    return { kind: 'outcome', outcome };
  }
}

export async function exactPrefixScan<T>(
  sequence: readonly T[],
  predicate: SearchPredicate<T>,
  options: PrefixSearchOptions = {},
): Promise<PrefixSearchResult<T>> {
  validateInputs(sequence, predicate, options);
  const snapshot = Object.freeze([...sequence]);
  const evaluator = new PrefixEvaluator(snapshot, predicate, options);
  return scanExactly(evaluator, {
    completedMode: 'exact',
    monotonicity: 'not_required',
    requestedMode: 'exact',
    usedFallback: false,
  });
}

export async function fastPrefixSearch<T>(
  sequence: readonly T[],
  predicate: SearchPredicate<T>,
  options: PrefixSearchOptions = {},
): Promise<PrefixSearchResult<T>> {
  validateInputs(sequence, predicate, options);
  const snapshot = Object.freeze([...sequence]);
  const evaluator = new PrefixEvaluator(snapshot, predicate, options);

  if (evaluator.hasObservedMonotonicityViolation()) {
    return scanExactly(evaluator, fallbackMetadata);
  }

  const empty = await evaluator.evaluate(0);
  if (empty.kind === 'budget_exhausted') {
    return inconclusive(evaluator, fastMetadata, 'budget_exhausted');
  }
  if (empty.outcome === 'UNRESOLVED') {
    return inconclusive(evaluator, fastMetadata, 'predicate_unresolved', 0);
  }
  if (empty.outcome === 'FAIL') {
    return inconclusive(evaluator, fastMetadata, 'empty_prefix_fails');
  }

  if (evaluator.length === 0) {
    return {
      ...resultBase(evaluator, {
        ...fastMetadata,
        completedMode: 'exact',
        monotonicity: 'not_required',
      }),
      exact: true,
      kind: 'not_found',
    };
  }

  const full = await evaluator.evaluate(evaluator.length);
  if (full.kind === 'budget_exhausted') {
    return inconclusive(evaluator, fastMetadata, 'budget_exhausted');
  }
  if (full.outcome === 'UNRESOLVED') {
    return inconclusive(evaluator, fastMetadata, 'predicate_unresolved', evaluator.length);
  }

  if (evaluator.hasObservedMonotonicityViolation()) {
    return scanExactly(evaluator, fallbackMetadata);
  }
  if (full.outcome !== 'FAIL') {
    return inconclusive(evaluator, fastMetadata, 'full_prefix_not_failing');
  }

  let lower = 0;
  let upper = evaluator.length;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    const evaluated = await evaluator.evaluate(middle);
    if (evaluated.kind === 'budget_exhausted') {
      return inconclusive(evaluator, fastMetadata, 'budget_exhausted');
    }
    if (evaluated.outcome === 'UNRESOLVED') {
      return inconclusive(evaluator, fastMetadata, 'predicate_unresolved', middle);
    }

    if (evaluator.hasObservedMonotonicityViolation()) {
      return scanExactly(evaluator, fallbackMetadata);
    }

    if (evaluated.outcome === 'FAIL') {
      upper = middle;
    } else {
      lower = middle;
    }
  }

  return {
    ...resultBase(evaluator, fastMetadata),
    exact: false,
    kind: 'found',
    prefix: evaluator.prefix(upper),
    prefixLength: upper,
  };
}

const fastMetadata: ResultMetadata = {
  completedMode: 'fast',
  monotonicity: 'not_established',
  requestedMode: 'fast',
  usedFallback: false,
};

const fallbackMetadata: ResultMetadata = {
  completedMode: 'exact',
  monotonicity: 'violated',
  requestedMode: 'fast',
  usedFallback: true,
};

async function scanExactly<T>(
  evaluator: PrefixEvaluator<T>,
  metadata: ResultMetadata,
): Promise<PrefixSearchResult<T>> {
  for (let length = 1; length <= evaluator.length; length += 1) {
    const evaluated = await evaluator.evaluate(length);
    if (evaluated.kind === 'budget_exhausted') {
      return inconclusive(evaluator, metadata, 'budget_exhausted');
    }
    if (evaluated.outcome === 'UNRESOLVED') {
      return inconclusive(evaluator, metadata, 'predicate_unresolved', length);
    }
    if (evaluated.outcome === 'FAIL') {
      return {
        ...resultBase(evaluator, metadata),
        exact: true,
        kind: 'found',
        prefix: evaluator.prefix(length),
        prefixLength: length,
      };
    }
  }

  return {
    ...resultBase(evaluator, metadata),
    exact: true,
    kind: 'not_found',
  };
}

function inconclusive<T>(
  evaluator: PrefixEvaluator<T>,
  metadata: ResultMetadata,
  reason: InconclusivePrefixResult['reason'],
  unresolvedLength?: number,
): InconclusivePrefixResult {
  const base = {
    ...resultBase(evaluator, metadata),
    exact: false,
    kind: 'inconclusive' as const,
    reason,
  };
  return unresolvedLength === undefined ? base : { ...base, unresolvedLength };
}

function resultBase<T>(
  evaluator: PrefixEvaluator<T>,
  metadata: ResultMetadata,
): Omit<PrefixResultBase, 'exact'> {
  return {
    completedMode: metadata.completedMode,
    evaluationCount: evaluator.evaluationCount,
    monotonicity: metadata.monotonicity,
    observations: evaluator.observations,
    requestedMode: metadata.requestedMode,
    usedFallback: metadata.usedFallback,
  };
}

function validateInputs<T>(
  sequence: readonly T[],
  predicate: SearchPredicate<T>,
  options: unknown,
): void {
  if (!Array.isArray(sequence)) {
    throw new TypeError('sequence must be an array');
  }
  if (typeof predicate !== 'function') {
    throw new TypeError('predicate must be a function');
  }
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  const candidate = options as Record<string, unknown>;
  const budget = candidate.budget;
  if (
    budget !== undefined &&
    (budget === null ||
      typeof budget !== 'object' ||
      typeof (budget as Record<string, unknown>).tryConsume !== 'function')
  ) {
    throw new TypeError('budget must implement EvaluationBudget');
  }
  const initialObservations = candidate.initialObservations;
  if (initialObservations !== undefined && !Array.isArray(initialObservations)) {
    throw new TypeError('initialObservations must be an array');
  }
}

function assertPrefixLength(length: unknown, maximum: number): asserts length is number {
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    throw new RangeError(`Prefix length must be a safe integer between 0 and ${String(maximum)}`);
  }
}

function assertKnownPrefixObservation(
  observation: unknown,
  maximum: number,
): asserts observation is KnownPrefixObservation {
  if (observation === null || typeof observation !== 'object') {
    throw new TypeError('A prefix observation must be an object');
  }
  const candidate = observation as Record<string, unknown>;
  assertPrefixLength(candidate.length, maximum);
  assertSearchPredicateOutcome(candidate.outcome);
}
