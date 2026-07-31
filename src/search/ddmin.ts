import type { SearchPredicate } from './prefix.js';
import {
  assertSearchPredicateOutcome,
  type EvaluationBudget,
  type SearchPredicateOutcome,
} from './stability.js';

export interface DdminOptions {
  readonly budget?: EvaluationBudget;
}

export type DdminPhase = 'initial' | 'complement' | 'subset' | 'deletion';

export interface DdminTraceEntry {
  readonly phase: DdminPhase;
  readonly occurrenceIndices: readonly number[];
  readonly outcome: SearchPredicateOutcome;
}

type LocalMinimality = 'proven' | 'unproven' | 'not_applicable';

interface DdminResultBase<T> {
  readonly candidate: readonly T[];
  readonly candidateOccurrenceIndices: readonly number[];
  readonly evaluationCount: number;
  readonly initialLength: number;
  readonly localMinimality: LocalMinimality;
  readonly trace: readonly DdminTraceEntry[];
  readonly unresolvedEvaluations: number;
}

export interface MinimizedDdminResult<T> extends DdminResultBase<T> {
  readonly kind: 'minimized';
  readonly localMinimality: 'proven' | 'unproven';
}

export interface PartialDdminResult<T> extends DdminResultBase<T> {
  readonly kind: 'partial';
  readonly localMinimality: 'unproven';
  readonly reason: 'budget_exhausted';
}

export interface InconclusiveDdminResult<T> extends DdminResultBase<T> {
  readonly kind: 'inconclusive';
  readonly localMinimality: 'unproven';
  readonly reason: 'budget_exhausted' | 'initial_unresolved';
}

export interface NotFailingDdminResult<T> extends DdminResultBase<T> {
  readonly kind: 'not_failing';
  readonly localMinimality: 'not_applicable';
}

export type DdminResult<T> =
  | MinimizedDdminResult<T>
  | PartialDdminResult<T>
  | InconclusiveDdminResult<T>
  | NotFailingDdminResult<T>;

export class DdminPredicateError extends Error {
  constructor(occurrenceIndices: readonly number[], cause: unknown) {
    super(`ddmin predicate threw for occurrences [${occurrenceIndices.join(', ')}]`, { cause });
    this.name = 'DdminPredicateError';
  }
}

interface Occurrence<T> {
  readonly index: number;
  readonly value: T;
}

type DdminEvaluation =
  | { readonly kind: 'outcome'; readonly outcome: SearchPredicateOutcome }
  | { readonly kind: 'budget_exhausted' };

class DdminEvaluator<T> {
  readonly #predicate: SearchPredicate<T>;
  readonly #budget: EvaluationBudget | undefined;
  readonly #cache = new Map<string, SearchPredicateOutcome>();
  readonly #trace: DdminTraceEntry[] = [];
  #evaluationCount = 0;
  #unresolvedEvaluations = 0;

  constructor(predicate: SearchPredicate<T>, budget?: EvaluationBudget) {
    this.#predicate = predicate;
    this.#budget = budget;
  }

  get evaluationCount(): number {
    return this.#evaluationCount;
  }

  get unresolvedEvaluations(): number {
    return this.#unresolvedEvaluations;
  }

  get trace(): readonly DdminTraceEntry[] {
    return Object.freeze([...this.#trace]);
  }

  async evaluate(candidate: readonly Occurrence<T>[], phase: DdminPhase): Promise<DdminEvaluation> {
    const key = occurrenceKey(candidate);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return { kind: 'outcome', outcome: cached };
    }

    if (this.#budget !== undefined && !this.#budget.tryConsume()) {
      return { kind: 'budget_exhausted' };
    }

    const indices = Object.freeze(candidate.map(({ index }) => index));
    const values = Object.freeze(candidate.map(({ value }) => value));
    let outcome: SearchPredicateOutcome;
    try {
      outcome = await this.#predicate(values);
    } catch (error) {
      throw new DdminPredicateError(indices, error);
    }
    assertSearchPredicateOutcome(outcome);

    this.#evaluationCount += 1;
    if (outcome === 'UNRESOLVED') {
      this.#unresolvedEvaluations += 1;
    }
    this.#cache.set(key, outcome);
    this.#trace.push(Object.freeze({ occurrenceIndices: indices, outcome, phase }));
    return { kind: 'outcome', outcome };
  }
}

export async function deterministicDdmin<T>(
  sequence: readonly T[],
  predicate: SearchPredicate<T>,
  options: DdminOptions = {},
): Promise<DdminResult<T>> {
  validateInputs(sequence, predicate, options);

  const initial = Object.freeze(sequence.map((value, index) => Object.freeze({ index, value })));
  const evaluator = new DdminEvaluator(predicate, options.budget);
  const initialEvaluation = await evaluator.evaluate(initial, 'initial');

  if (initialEvaluation.kind === 'budget_exhausted') {
    return result(evaluator, initial, sequence.length, {
      kind: 'inconclusive',
      localMinimality: 'unproven',
      reason: 'budget_exhausted',
    });
  }
  if (initialEvaluation.outcome === 'UNRESOLVED') {
    return result(evaluator, initial, sequence.length, {
      kind: 'inconclusive',
      localMinimality: 'unproven',
      reason: 'initial_unresolved',
    });
  }
  if (initialEvaluation.outcome === 'NOT_FAIL') {
    return result(evaluator, initial, sequence.length, {
      kind: 'not_failing',
      localMinimality: 'not_applicable',
    });
  }

  let current = initial;
  let granularity = Math.min(2, current.length);
  const visitedStates = new Set<string>();

  while (current.length >= 2) {
    const stateKey = `${occurrenceKey(current)}|${String(granularity)}`;
    if (visitedStates.has(stateKey)) {
      throw new Error(`ddmin entered a repeated state: ${stateKey}`);
    }
    visitedStates.add(stateKey);

    const subsets = partition(current, granularity);
    let reduced: readonly Occurrence<T>[] | undefined;

    for (const subset of subsets) {
      const complement = withoutOccurrences(current, subset);
      const evaluated = await evaluator.evaluate(complement, 'complement');
      if (evaluated.kind === 'budget_exhausted') {
        return partialResult(evaluator, current, sequence.length);
      }
      if (evaluated.outcome === 'FAIL') {
        reduced = complement;
        granularity = Math.max(2, granularity - 1);
        break;
      }
    }

    if (reduced !== undefined) {
      current = reduced;
      continue;
    }

    for (const subset of subsets) {
      const evaluated = await evaluator.evaluate(subset, 'subset');
      if (evaluated.kind === 'budget_exhausted') {
        return partialResult(evaluator, current, sequence.length);
      }
      if (evaluated.outcome === 'FAIL') {
        reduced = subset;
        granularity = 2;
        break;
      }
    }

    if (reduced !== undefined) {
      current = reduced;
      continue;
    }

    if (granularity >= current.length) {
      break;
    }
    granularity = Math.min(current.length, granularity * 2);
  }

  let unresolvedDeletion = false;
  let cursor = 0;
  while (cursor < current.length) {
    const candidate = Object.freeze([...current.slice(0, cursor), ...current.slice(cursor + 1)]);
    const evaluated = await evaluator.evaluate(candidate, 'deletion');
    if (evaluated.kind === 'budget_exhausted') {
      return partialResult(evaluator, current, sequence.length);
    }

    if (evaluated.outcome === 'FAIL') {
      current = candidate;
      cursor = 0;
      continue;
    }
    if (evaluated.outcome === 'UNRESOLVED') {
      unresolvedDeletion = true;
    }
    cursor += 1;
  }

  return result(evaluator, current, sequence.length, {
    kind: 'minimized',
    localMinimality: unresolvedDeletion ? 'unproven' : 'proven',
  });
}

function partialResult<T>(
  evaluator: DdminEvaluator<T>,
  current: readonly Occurrence<T>[],
  initialLength: number,
): PartialDdminResult<T> {
  return result(evaluator, current, initialLength, {
    kind: 'partial',
    localMinimality: 'unproven',
    reason: 'budget_exhausted',
  });
}

function result<
  T,
  R extends
    | Pick<MinimizedDdminResult<T>, 'kind' | 'localMinimality'>
    | Pick<PartialDdminResult<T>, 'kind' | 'localMinimality' | 'reason'>
    | Pick<InconclusiveDdminResult<T>, 'kind' | 'localMinimality' | 'reason'>
    | Pick<NotFailingDdminResult<T>, 'kind' | 'localMinimality'>,
>(
  evaluator: DdminEvaluator<T>,
  candidate: readonly Occurrence<T>[],
  initialLength: number,
  variant: R,
): DdminResult<T> & R {
  return {
    ...variant,
    candidate: Object.freeze(candidate.map(({ value }) => value)),
    candidateOccurrenceIndices: Object.freeze(candidate.map(({ index }) => index)),
    evaluationCount: evaluator.evaluationCount,
    initialLength,
    trace: evaluator.trace,
    unresolvedEvaluations: evaluator.unresolvedEvaluations,
  } as DdminResult<T> & R;
}

function partition<T>(
  candidate: readonly Occurrence<T>[],
  granularity: number,
): readonly (readonly Occurrence<T>[])[] {
  const subsets: (readonly Occurrence<T>[])[] = [];
  for (let index = 0; index < granularity; index += 1) {
    const start = Math.floor((index * candidate.length) / granularity);
    const end = Math.floor(((index + 1) * candidate.length) / granularity);
    if (start < end) {
      subsets.push(Object.freeze(candidate.slice(start, end)));
    }
  }
  return Object.freeze(subsets);
}

function withoutOccurrences<T>(
  candidate: readonly Occurrence<T>[],
  removed: readonly Occurrence<T>[],
): readonly Occurrence<T>[] {
  const removedIndices = new Set(removed.map(({ index }) => index));
  return Object.freeze(candidate.filter(({ index }) => !removedIndices.has(index)));
}

function occurrenceKey<T>(candidate: readonly Occurrence<T>[]): string {
  return candidate.map(({ index }) => index).join(',');
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
}
