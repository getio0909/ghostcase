export type FindingVerdict =
  | 'CLEAN'
  | 'HARNESS_ERROR'
  | 'HIDDEN_DEPENDENCY'
  | 'INCONCLUSIVE'
  | 'NON_REPRODUCIBLE'
  | 'OUTCOME_SHIFT'
  | 'POLLUTION';

export interface StableArm {
  readonly kind: 'stable';
  readonly oracleOutcome: 'fail' | 'pass';
  readonly signature: string;
}

export interface NonReproducibleArm {
  readonly kind: 'non_reproducible';
}

export interface HarnessErrorArm {
  readonly kind: 'harness_error';
  readonly reason: string;
}

export interface InconclusiveArm {
  readonly kind: 'inconclusive';
  readonly reason: string;
}

export type ArmClassification = HarnessErrorArm | InconclusiveArm | NonReproducibleArm | StableArm;

export function classifyArms(fresh: ArmClassification, shared: ArmClassification): FindingVerdict {
  if (fresh.kind === 'harness_error' || shared.kind === 'harness_error') {
    return 'HARNESS_ERROR';
  }
  if (fresh.kind === 'non_reproducible' || shared.kind === 'non_reproducible') {
    return 'NON_REPRODUCIBLE';
  }
  if (fresh.kind === 'inconclusive' || shared.kind === 'inconclusive') {
    return 'INCONCLUSIVE';
  }
  if (fresh.oracleOutcome === 'pass' && shared.oracleOutcome === 'fail') {
    return 'POLLUTION';
  }
  if (fresh.oracleOutcome === 'fail' && shared.oracleOutcome === 'pass') {
    return 'HIDDEN_DEPENDENCY';
  }
  return fresh.signature === shared.signature ? 'CLEAN' : 'OUTCOME_SHIFT';
}

export function isConfirmedDependency(
  verdict: FindingVerdict,
): verdict is 'HIDDEN_DEPENDENCY' | 'POLLUTION' {
  return verdict === 'POLLUTION' || verdict === 'HIDDEN_DEPENDENCY';
}
