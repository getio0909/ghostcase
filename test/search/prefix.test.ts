import { describe, expect, it } from 'vitest';

import { createEvaluationBudget } from '../../src/search/stability.js';
import {
  exactPrefixScan,
  fastPrefixSearch,
  type SearchPredicate,
} from '../../src/search/prefix.js';

function thresholdPredicate(
  outcomes: readonly ('FAIL' | 'NOT_FAIL' | 'UNRESOLVED')[],
): SearchPredicate<string> {
  return (prefix) => {
    const outcome = outcomes[prefix.length];
    if (outcome === undefined) {
      throw new RangeError('Missing fixture outcome');
    }
    return outcome;
  };
}

describe('exactPrefixScan', () => {
  it('finds the earliest failure even when a later prefix cleans it', async () => {
    const sequence = ['polluter', 'cleaner', 'polluter-2'];
    const result = await exactPrefixScan(
      sequence,
      thresholdPredicate(['NOT_FAIL', 'FAIL', 'NOT_FAIL', 'FAIL']),
    );

    expect(result).toMatchObject({
      kind: 'found',
      exact: true,
      prefix: ['polluter'],
      prefixLength: 1,
      requestedMode: 'exact',
    });
  });

  it('does not claim an exact first failure across an unresolved prefix', async () => {
    const result = await exactPrefixScan(
      ['a', 'b', 'c'],
      thresholdPredicate(['NOT_FAIL', 'NOT_FAIL', 'UNRESOLVED', 'FAIL']),
    );

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'predicate_unresolved',
      unresolvedLength: 2,
    });
  });

  it('returns a budget-bounded inconclusive result', async () => {
    const result = await exactPrefixScan(
      ['a', 'b'],
      thresholdPredicate(['NOT_FAIL', 'NOT_FAIL', 'FAIL']),
      { budget: createEvaluationBudget(1) },
    );

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'budget_exhausted',
    });
    expect(result.evaluationCount).toBe(1);
  });
});

describe('fastPrefixSearch', () => {
  it('returns only a local boundary when monotonicity is not established', async () => {
    const result = await fastPrefixSearch(
      ['a', 'b', 'c', 'd'],
      thresholdPredicate(['NOT_FAIL', 'NOT_FAIL', 'NOT_FAIL', 'FAIL', 'FAIL']),
    );

    expect(result).toMatchObject({
      kind: 'found',
      exact: false,
      monotonicity: 'not_established',
      prefixLength: 3,
      usedFallback: false,
    });
  });

  it('falls back to an exact scan when existing observations prove non-monotonicity', async () => {
    const outcomes = ['NOT_FAIL', 'FAIL', 'NOT_FAIL', 'FAIL'] as const;
    const result = await fastPrefixSearch(
      ['polluter', 'cleaner', 'polluter-2'],
      thresholdPredicate(outcomes),
      {
        initialObservations: [
          { length: 1, outcome: 'FAIL' },
          { length: 2, outcome: 'NOT_FAIL' },
        ],
      },
    );

    expect(result).toMatchObject({
      kind: 'found',
      exact: true,
      monotonicity: 'violated',
      prefix: ['polluter'],
      prefixLength: 1,
      requestedMode: 'fast',
      usedFallback: true,
    });
  });

  it('refuses to search when the empty prefix already fails', async () => {
    const result = await fastPrefixSearch(['a'], thresholdPredicate(['FAIL', 'FAIL']));

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'empty_prefix_fails',
    });
  });

  it('does not infer absence from a non-failing full prefix', async () => {
    const result = await fastPrefixSearch(
      ['polluter', 'cleaner'],
      thresholdPredicate(['NOT_FAIL', 'FAIL', 'NOT_FAIL']),
    );

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'full_prefix_not_failing',
    });
  });

  it('rejects contradictory initial observations', async () => {
    await expect(
      fastPrefixSearch(['a'], thresholdPredicate(['NOT_FAIL', 'FAIL']), {
        initialObservations: [
          { length: 1, outcome: 'FAIL' },
          { length: 1, outcome: 'NOT_FAIL' },
        ],
      }),
    ).rejects.toThrow(/Conflicting/);
  });
});
