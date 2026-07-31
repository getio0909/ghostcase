export type GhostCaseErrorCode =
  | 'CONFIG_ERROR'
  | 'EVIDENCE_ERROR'
  | 'FIXTURE_ERROR'
  | 'HARNESS_ERROR'
  | 'INTERNAL_ERROR'
  | 'USAGE_ERROR';

export class GhostCaseError extends Error {
  readonly code: GhostCaseErrorCode;
  readonly exitCode: 1 | 2 | 3;

  constructor(
    code: GhostCaseErrorCode,
    message: string,
    exitCode: 1 | 2 | 3,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GhostCaseError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('USAGE_ERROR', message, 2, options);
    this.name = 'UsageError';
  }
}

export class ConfigError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIG_ERROR', message, 2, options);
    this.name = 'ConfigError';
  }
}

export class FixtureError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('FIXTURE_ERROR', message, 2, options);
    this.name = 'FixtureError';
  }
}

export class EvidenceError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('EVIDENCE_ERROR', message, 2, options);
    this.name = 'EvidenceError';
  }
}

export class HarnessError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('HARNESS_ERROR', message, 3, options);
    this.name = 'HarnessError';
  }
}

export class InternalError extends GhostCaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('INTERNAL_ERROR', message, 3, options);
    this.name = 'InternalError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Unknown failure.';
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
