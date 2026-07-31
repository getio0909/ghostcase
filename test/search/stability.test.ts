import { describe, expect, it } from 'vitest';

import {
  createEvaluationBudget,
  evaluateStability,
  type StabilityAttempt,
} from '../../src/search/stability.js';

describe('evaluateStability', () => {
  it('accepts invalid attempts without counting them as confirmations', async () => {
    const attempts: StabilityAttempt<number, string>[] = [
      { kind: 'invalid', reason: 'reset failed' },
      { kind: 'valid', signature: 'pass', value: 1 },
      { kind: 'invalid', reason: 'harness failed' },
      { kind: 'valid', signature: 'pass', value: 2 },
      { kind: 'valid', signature: 'pass', value: 3 },
    ];

    const result = await evaluateStability(
      (attemptIndex) => {
        const attempt = attempts[attemptIndex];
        if (attempt === undefined) {
          throw new RangeError('Unexpected attempt index');
        }
        return attempt;
      },
      { maxAttempts: 5, requiredValidRuns: 3 },
    );

    expect(result).toMatchObject({
      kind: 'stable',
      signature: 'pass',
      validValues: [1, 2, 3],
    });
    expect(result.attempts).toHaveLength(5);
  });

  it('rejects conflicting valid signatures as non-reproducible', async () => {
    const signatures = ['pass', 'fail'];

    const result = await evaluateStability(
      (attemptIndex) => {
        const signature = signatures[attemptIndex];
        if (signature === undefined) {
          throw new RangeError('Unexpected attempt index');
        }
        return {
          kind: 'valid' as const,
          signature,
          value: attemptIndex,
        };
      },
      { maxAttempts: 4, requiredValidRuns: 3 },
    );

    expect(result).toMatchObject({
      kind: 'non_reproducible',
      signatures: ['pass', 'fail'],
    });
    expect(result.attempts).toHaveLength(2);
  });

  it('is inconclusive when the attempt limit cannot supply enough valid runs', async () => {
    const result = await evaluateStability(() => ({ kind: 'invalid' as const, reason: 'infra' }), {
      maxAttempts: 3,
      requiredValidRuns: 2,
    });

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'attempt_limit',
      validRuns: 0,
    });
  });

  it('does not turn one physical attempt into repeated evidence when budget expires', async () => {
    const budget = createEvaluationBudget(1);
    let executions = 0;

    const result = await evaluateStability(
      () => {
        executions += 1;
        return { kind: 'valid' as const, signature: 'pass', value: executions };
      },
      { budget, maxAttempts: 5, requiredValidRuns: 3 },
    );

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'budget_exhausted',
      validRuns: 1,
    });
    expect(executions).toBe(1);
    expect(budget.used).toBe(1);
  });

  it('validates configuration before executing an attempt', async () => {
    let executed = false;

    await expect(
      evaluateStability(
        () => {
          executed = true;
          return { kind: 'valid', signature: 'pass', value: 1 };
        },
        { maxAttempts: 2, requiredValidRuns: 3 },
      ),
    ).rejects.toThrow(/maxAttempts/);
    expect(executed).toBe(false);
  });

  it('rejects malformed signatures returned by an untyped adapter', async () => {
    await expect(
      evaluateStability(
        () => ({
          kind: 'valid',
          signature: '',
          value: 1,
        }),
        { maxAttempts: 1, requiredValidRuns: 1 },
      ),
    ).rejects.toThrow(/signature/);
  });
});
