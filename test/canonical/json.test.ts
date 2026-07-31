import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSha256,
  type CanonicalJsonValue,
} from '../../src/canonical/json.js';

describe('canonicalJson', () => {
  it('sorts object keys by UTF-8 bytes while preserving array order', () => {
    expect(
      canonicalJson({
        z: 1,
        a: [{ second: true, first: null }, 'value'],
      }),
    ).toBe('{"a":[{"first":null,"second":true},"value"],"z":1}');
  });

  it('does not mutate or retain shared but acyclic objects', () => {
    const shared = { value: 1 };
    const input = { left: shared, right: shared };
    expect(canonicalJson(input)).toBe('{"left":{"value":1},"right":{"value":1}}');
    expect(input).toEqual({ left: { value: 1 }, right: { value: 1 } });
  });

  it.each([
    [Number.NaN, 'finite'],
    [Number.POSITIVE_INFINITY, 'finite'],
    [-0, '-0'],
    [Number.MAX_SAFE_INTEGER + 1, 'safe integers'],
    ['\ud800', 'lone surrogates'],
  ] as const)('rejects values outside the portable JSON domain', (value, message) => {
    expect(() => canonicalJson(value)).toThrow(message);
  });

  it('rejects cycles and non-plain objects', () => {
    const cyclic: { self?: CanonicalJsonValue } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('cycles');
    expect(() => canonicalJson(new Date() as unknown as CanonicalJsonValue)).toThrow(
      'plain or null prototype',
    );
  });
});

describe('canonicalSha256', () => {
  it('is stable for equivalent objects and domain separated', () => {
    const left = canonicalSha256('ghostcase/evidence/v1', { b: 2, a: 1 });
    const right = canonicalSha256('ghostcase/evidence/v1', { a: 1, b: 2 });
    expect(right).toBe(left);
    expect(canonicalSha256('ghostcase/other/v1', { a: 1, b: 2 })).not.toBe(left);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(['', 'bad\0domain'])('rejects an unsafe digest domain', (domain) => {
    expect(() => canonicalSha256(domain, null)).toThrow(CanonicalJsonError);
  });
});
