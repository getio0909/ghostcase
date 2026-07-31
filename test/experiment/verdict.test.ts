import { describe, expect, it } from 'vitest';

import {
  classifyArms,
  isConfirmedDependency,
  type ArmClassification,
  type FindingVerdict,
} from '../../src/experiment/verdict.js';

const pass: ArmClassification = {
  kind: 'stable',
  oracleOutcome: 'pass',
  signature: 'pass-signature',
};
const fail: ArmClassification = {
  kind: 'stable',
  oracleOutcome: 'fail',
  signature: 'fail-signature',
};

describe('classifyArms', () => {
  it.each([
    [pass, { ...pass }, 'CLEAN'],
    [pass, fail, 'POLLUTION'],
    [fail, pass, 'HIDDEN_DEPENDENCY'],
    [fail, { ...fail }, 'CLEAN'],
    [pass, { ...pass, signature: 'different-pass' }, 'OUTCOME_SHIFT'],
    [fail, { ...fail, signature: 'different-failure' }, 'OUTCOME_SHIFT'],
  ] as const)('classifies stable fresh/shared observations', (fresh, shared, expected) => {
    expect(classifyArms(fresh, shared)).toBe(expected);
  });

  it('gives harness errors precedence over instability and incomplete evidence', () => {
    expect(
      classifyArms(
        { kind: 'non_reproducible' },
        { kind: 'harness_error', reason: 'tree termination failed' },
      ),
    ).toBe('HARNESS_ERROR');
    expect(
      classifyArms(
        { kind: 'inconclusive', reason: 'budget exhausted' },
        { kind: 'harness_error', reason: 'snapshot failed' },
      ),
    ).toBe('HARNESS_ERROR');
  });

  it('gives non-reproducibility precedence over other incomplete evidence', () => {
    expect(
      classifyArms(
        { kind: 'inconclusive', reason: 'budget exhausted' },
        { kind: 'non_reproducible' },
      ),
    ).toBe('NON_REPRODUCIBLE');
  });
});

describe('isConfirmedDependency', () => {
  it.each([
    ['POLLUTION', true],
    ['HIDDEN_DEPENDENCY', true],
    ['CLEAN', false],
    ['OUTCOME_SHIFT', false],
    ['NON_REPRODUCIBLE', false],
    ['INCONCLUSIVE', false],
    ['HARNESS_ERROR', false],
  ] as const)('recognizes only directional pass/fail shifts', (verdict, expected) => {
    expect(isConfirmedDependency(verdict satisfies FindingVerdict)).toBe(expected);
  });
});
