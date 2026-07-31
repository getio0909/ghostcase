import { describe, expect, it } from 'vitest';

import { currentHostPlatform } from '../../src/platform/host.js';

describe('currentHostPlatform', () => {
  it.each([
    ['linux', 'linux'],
    ['win32', 'win32'],
    ['darwin', undefined],
    ['freebsd', undefined],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(currentHostPlatform(input)).toBe(expected);
  });
});
