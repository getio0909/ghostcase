import { describe, expect, it } from 'vitest';

import {
  JsonPointerError,
  StrictJsonError,
  jsonDeepEqual,
  parseStrictJson,
  resolveJsonPointer,
} from '../../src/oracle/json-pointer.js';

describe('parseStrictJson', () => {
  it('parses every JSON value category without changing object key order semantics', () => {
    expect(
      parseStrictJson(
        '{"string":"value","number":1.5,"boolean":true,"nil":null,"array":[0,false]}',
      ),
    ).toEqual({
      string: 'value',
      number: 1.5,
      boolean: true,
      nil: null,
      array: [0, false],
    });
  });

  it.each([
    ['{"same":1,"same":2}', 'same'],
    ['{"same":1,"\\u0073ame":2}', 'same'],
    ['{"nested":{"same":1,"same":2}}', 'same'],
  ])('rejects duplicate object keys in %s', (source, key) => {
    expect(() => parseStrictJson(source)).toThrow(
      new StrictJsonError(`Duplicate object key ${JSON.stringify(key)}.`),
    );
  });

  it.each([
    ['1e400', /finite/],
    ['"\\ud800"', /surrogate/],
    ['{"x":1} trailing', /end of input/],
    ['[1,]', /JSON value/],
  ])('rejects non-strict JSON %s', (source, message) => {
    expect(() => parseStrictJson(source)).toThrow(message);
  });
});

describe('resolveJsonPointer', () => {
  const document = parseStrictJson(
    '{"a/b":{"m~n":[{"value":42}]},"":{"01":"object-key"},"array":["zero","one"]}',
  );

  it.each([
    ['', document],
    ['/a~1b/m~0n/0/value', 42],
    ['//01', 'object-key'],
    ['/array/0', 'zero'],
  ])('resolves RFC 6901 pointer %j', (pointer, expected) => {
    expect(resolveJsonPointer(document, pointer)).toEqual({
      found: true,
      value: expected,
    });
  });

  it.each(['/missing', '/array/2', '/array/01', '/array/-'])(
    'returns a missing result for an unresolved pointer %j',
    (pointer) => {
      expect(resolveJsonPointer(document, pointer)).toEqual({ found: false });
    },
  );

  it.each(['relative', '/bad~2escape', '/dangling~'])('rejects malformed pointer %j', (pointer) => {
    expect(() => resolveJsonPointer(document, pointer)).toThrow(JsonPointerError);
  });
});

describe('jsonDeepEqual', () => {
  it('compares objects independent of key order and arrays in order', () => {
    expect(
      jsonDeepEqual(parseStrictJson('{"a":1,"b":[2,3]}'), parseStrictJson('{"b":[2,3],"a":1}')),
    ).toBe(true);
    expect(
      jsonDeepEqual(parseStrictJson('{"a":1,"b":[2,3]}'), parseStrictJson('{"b":[3,2],"a":1}')),
    ).toBe(false);
  });
});
