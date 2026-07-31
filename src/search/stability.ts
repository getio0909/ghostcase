export type MaybePromise<T> = T | PromiseLike<T>;

export type SearchPredicateOutcome = 'FAIL' | 'NOT_FAIL' | 'UNRESOLVED';

export interface EvaluationBudget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  tryConsume(amount?: number): boolean;
}

class FixedEvaluationBudget implements EvaluationBudget {
  readonly #limit: number;
  #used = 0;

  constructor(limit: number) {
    assertNonNegativeInteger(limit, 'limit');
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return this.#limit - this.#used;
  }

  tryConsume(amount = 1): boolean {
    assertPositiveInteger(amount, 'amount');
    if (amount > this.remaining) {
      return false;
    }
    this.#used += amount;
    return true;
  }
}

export function createEvaluationBudget(limit: number): EvaluationBudget {
  return new FixedEvaluationBudget(limit);
}

export interface ValidStabilityAttempt<T> {
  readonly kind: 'valid';
  readonly signature: string;
  readonly value: T;
}

export interface InvalidStabilityAttempt<E = unknown> {
  readonly kind: 'invalid';
  readonly reason: E;
}

export type StabilityAttempt<T, E = unknown> =
  ValidStabilityAttempt<T> | InvalidStabilityAttempt<E>;

export interface StabilityOptions {
  readonly requiredValidRuns: number;
  readonly maxAttempts: number;
  readonly budget?: EvaluationBudget;
}

interface StabilityResultBase<T, E> {
  readonly attempts: readonly StabilityAttempt<T, E>[];
  readonly validRuns: number;
}

export interface StableResult<T, E = unknown> extends StabilityResultBase<T, E> {
  readonly kind: 'stable';
  readonly signature: string;
  readonly validValues: readonly T[];
}

export interface NonReproducibleResult<T, E = unknown> extends StabilityResultBase<T, E> {
  readonly kind: 'non_reproducible';
  readonly signatures: readonly string[];
  readonly validValues: readonly T[];
}

export interface InconclusiveStabilityResult<T, E = unknown> extends StabilityResultBase<T, E> {
  readonly kind: 'inconclusive';
  readonly reason: 'attempt_limit' | 'budget_exhausted';
}

export type StabilityResult<T, E = unknown> =
  StableResult<T, E> | NonReproducibleResult<T, E> | InconclusiveStabilityResult<T, E>;

export class StabilityExecutionError extends Error {
  constructor(attemptIndex: number, cause: unknown) {
    super(`Stability attempt ${String(attemptIndex)} threw instead of returning an attempt`, {
      cause,
    });
    this.name = 'StabilityExecutionError';
  }
}

export async function evaluateStability<T, E = unknown>(
  execute: (attemptIndex: number) => MaybePromise<StabilityAttempt<T, E>>,
  options: StabilityOptions,
): Promise<StabilityResult<T, E>> {
  if (typeof execute !== 'function') {
    throw new TypeError('execute must be a function');
  }
  validateStabilityOptions(options);
  const { budget, maxAttempts, requiredValidRuns } = options;

  const attempts: StabilityAttempt<T, E>[] = [];
  const validValues: T[] = [];
  const signatures: string[] = [];
  let expectedSignature: string | undefined;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (budget !== undefined && !budget.tryConsume()) {
      return {
        attempts: frozenCopy(attempts),
        kind: 'inconclusive',
        reason: 'budget_exhausted',
        validRuns: validValues.length,
      };
    }

    let attempt: StabilityAttempt<T, E>;
    try {
      attempt = await execute(attemptIndex);
    } catch (error) {
      throw new StabilityExecutionError(attemptIndex, error);
    }
    assertStabilityAttempt(attempt);
    attempts.push(attempt);

    if (attempt.kind === 'invalid') {
      continue;
    }

    validValues.push(attempt.value);
    if (!signatures.includes(attempt.signature)) {
      signatures.push(attempt.signature);
    }

    if (expectedSignature !== undefined && attempt.signature !== expectedSignature) {
      return {
        attempts: frozenCopy(attempts),
        kind: 'non_reproducible',
        signatures: frozenCopy(signatures),
        validRuns: validValues.length,
        validValues: frozenCopy(validValues),
      };
    }

    expectedSignature = attempt.signature;
    if (validValues.length === requiredValidRuns) {
      return {
        attempts: frozenCopy(attempts),
        kind: 'stable',
        signature: expectedSignature,
        validRuns: validValues.length,
        validValues: frozenCopy(validValues),
      };
    }
  }

  return {
    attempts: frozenCopy(attempts),
    kind: 'inconclusive',
    reason: 'attempt_limit',
    validRuns: validValues.length,
  };
}

function validateStabilityOptions(options: unknown): asserts options is StabilityOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  const candidate = options as Record<string, unknown>;
  const requiredValidRuns = candidate.requiredValidRuns;
  const maxAttempts = candidate.maxAttempts;
  assertPositiveInteger(requiredValidRuns, 'requiredValidRuns');
  assertPositiveInteger(maxAttempts, 'maxAttempts');
  if (maxAttempts < requiredValidRuns) {
    throw new RangeError('maxAttempts must be greater than or equal to requiredValidRuns');
  }
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

function assertStabilityAttempt<T, E>(attempt: unknown): asserts attempt is StabilityAttempt<T, E> {
  if (attempt === null || typeof attempt !== 'object') {
    throw new TypeError('A stability attempt must be an object');
  }

  const candidate = attempt as Record<string, unknown>;
  if (candidate.kind === 'invalid') {
    if (!Object.hasOwn(candidate, 'reason')) {
      throw new TypeError('An invalid stability attempt must include a reason');
    }
    return;
  }
  if (candidate.kind !== 'valid') {
    throw new TypeError('A stability attempt kind must be valid or invalid');
  }
  const signature = candidate.signature;
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    throw new TypeError('A valid stability attempt signature must be non-empty');
  }
  if (!Object.hasOwn(candidate, 'value')) {
    throw new TypeError('A valid stability attempt must include a value');
  }
}

export function assertSearchPredicateOutcome(
  outcome: unknown,
): asserts outcome is SearchPredicateOutcome {
  if (outcome !== 'FAIL' && outcome !== 'NOT_FAIL' && outcome !== 'UNRESOLVED') {
    throw new TypeError('A search predicate result must be FAIL, NOT_FAIL, or UNRESOLVED');
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function frozenCopy<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
