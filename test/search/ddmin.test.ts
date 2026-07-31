import { describe, expect, it } from 'vitest';

import { deterministicDdmin } from '../../src/search/ddmin.js';
import { createEvaluationBudget } from '../../src/search/stability.js';

describe('deterministicDdmin', () => {
  it('removes noise around a single pollution occurrence', async () => {
    const result = await deterministicDdmin(
      ['noise-a', 'polluter', 'noise-b', 'noise-c'],
      (candidate) => (candidate.includes('polluter') ? 'FAIL' : 'NOT_FAIL'),
    );

    expect(result).toMatchObject({
      kind: 'minimized',
      candidate: ['polluter'],
      candidateOccurrenceIndices: [1],
      localMinimality: 'proven',
    });
  });

  it('preserves a synergistic pair that is harmless in isolation', async () => {
    const result = await deterministicDdmin(['a', 'noise', 'b'], (candidate) =>
      candidate.includes('a') && candidate.includes('b') ? 'FAIL' : 'NOT_FAIL',
    );

    expect(result).toMatchObject({
      kind: 'minimized',
      candidate: ['a', 'b'],
      candidateOccurrenceIndices: [0, 2],
      localMinimality: 'proven',
    });
  });

  it('distinguishes duplicate values by original occurrence index', async () => {
    const result = await deterministicDdmin(['same', 'same'], (candidate) =>
      candidate.length === 2 ? 'FAIL' : 'NOT_FAIL',
    );

    expect(result).toMatchObject({
      kind: 'minimized',
      candidate: ['same', 'same'],
      candidateOccurrenceIndices: [0, 1],
      localMinimality: 'proven',
    });
  });

  it('marks local minimality unproven when a final deletion is unresolved', async () => {
    const result = await deterministicDdmin(['polluter'], (candidate) => {
      if (candidate.length === 1) {
        return 'FAIL';
      }
      return 'UNRESOLVED';
    });

    expect(result).toMatchObject({
      kind: 'minimized',
      candidate: ['polluter'],
      localMinimality: 'unproven',
      unresolvedEvaluations: 1,
    });
  });

  it('returns the last confirmed failing candidate when budget expires', async () => {
    const result = await deterministicDdmin(
      ['a', 'b', 'c'],
      (candidate) => (candidate.includes('b') ? 'FAIL' : 'NOT_FAIL'),
      { budget: createEvaluationBudget(1) },
    );

    expect(result).toMatchObject({
      kind: 'partial',
      candidate: ['a', 'b', 'c'],
      localMinimality: 'unproven',
      reason: 'budget_exhausted',
    });
  });

  it('is inconclusive when the initial witness cannot be resolved', async () => {
    const result = await deterministicDdmin(['a', 'b'], () => 'UNRESOLVED' as const);

    expect(result).toMatchObject({
      kind: 'inconclusive',
      reason: 'initial_unresolved',
      localMinimality: 'unproven',
    });
    expect(result.evaluationCount).toBe(1);
  });

  it('reports a non-failing initial candidate without attempting reduction', async () => {
    const result = await deterministicDdmin(['a', 'b'], () => 'NOT_FAIL' as const);

    expect(result).toMatchObject({
      kind: 'not_failing',
      candidate: ['a', 'b'],
    });
    expect(result.evaluationCount).toBe(1);
  });

  it('produces the same witness and trace for competing reductions', async () => {
    const predicate = (candidate: readonly string[]): 'FAIL' | 'NOT_FAIL' =>
      candidate.includes('left') || candidate.includes('right') ? 'FAIL' : 'NOT_FAIL';

    const first = await deterministicDdmin(['left', 'noise', 'right'], predicate);
    const second = await deterministicDdmin(['left', 'noise', 'right'], predicate);

    expect(second).toEqual(first);
  });

  it('rejects an invalid predicate result at runtime', async () => {
    await expect(deterministicDdmin(['a'], () => 'MAYBE' as unknown as 'FAIL')).rejects.toThrow(
      /predicate result/,
    );
  });
});
