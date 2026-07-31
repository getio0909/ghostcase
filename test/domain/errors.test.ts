import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  errorMessage,
  EvidenceError,
  FixtureError,
  GhostCaseError,
  HarnessError,
  InternalError,
  isNodeError,
  UsageError,
} from '../../src/domain/errors.js';

describe('GhostCase errors', () => {
  it.each([
    [new UsageError('usage'), 'USAGE_ERROR', 2],
    [new ConfigError('config'), 'CONFIG_ERROR', 2],
    [new FixtureError('fixture'), 'FIXTURE_ERROR', 2],
    [new EvidenceError('evidence'), 'EVIDENCE_ERROR', 2],
    [new HarnessError('harness'), 'HARNESS_ERROR', 3],
    [new InternalError('internal'), 'INTERNAL_ERROR', 3],
  ] as const)('provides stable machine codes and exit codes', (error, code, exitCode) => {
    expect(error).toBeInstanceOf(GhostCaseError);
    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(exitCode);
    expect(error.message).toBe(errorMessage(error));
  });

  it('does not expose arbitrary thrown values as messages', () => {
    expect(errorMessage('sentinel secret')).toBe('Unknown failure.');
    expect(errorMessage(new Error(''))).toBe('Unknown failure.');
  });

  it('recognizes Node-style errors structurally', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(isNodeError(error)).toBe(true);
    expect(isNodeError(new Error('plain'))).toBe(false);
  });
});
