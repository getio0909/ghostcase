import { describe, expect, it } from 'vitest';

import {
  StrictJsonError,
  STRICT_JSON_LIMITS,
  parseStrictJsonBytes,
} from '../../src/config/strict-json.js';

const encoder = new TextEncoder();

describe('parseStrictJsonBytes', () => {
  it('parses a strict UTF-8 JSON document', () => {
    expect(parseStrictJsonBytes(encoder.encode('{"array":[true,null,1.5],"text":"ok"}'))).toEqual({
      array: [true, null, 1.5],
      text: 'ok',
    });
  });

  it.each([
    ['invalid UTF-8', Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]), 'UTF-8'],
    ['UTF-8 BOM', Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'BOM'],
  ])('rejects %s', (_label, bytes, message) => {
    expect(() => parseStrictJsonBytes(bytes)).toThrow(StrictJsonError);
    expect(() => parseStrictJsonBytes(bytes)).toThrow(message);
  });

  it.each([
    ['{"id":"first","id":"second"}', 'duplicate object key'],
    ['{"\\u0069d":"first","id":"second"}', 'duplicate object key'],
    ['{"nested":{"value":1,"value":2}}', 'duplicate object key'],
    ['{"__proto__":{}}', 'forbidden object key'],
    ['{"prototype":{}}', 'forbidden object key'],
    ['{"constructor":{}}', 'forbidden object key'],
    ['{"value":-0}', 'negative zero'],
    ['{"value":9007199254740992}', 'safe integer'],
    ['{"value":"\\ud800"}', 'lone surrogate'],
  ])('rejects unsafe JSON: %s', (source, message) => {
    expect(() => parseStrictJsonBytes(encoder.encode(source))).toThrow(message);
  });

  it('rejects documents beyond the structural limits', () => {
    const tooDeep = `${'['.repeat(STRICT_JSON_LIMITS.maxDepth + 1)}0${']'.repeat(
      STRICT_JSON_LIMITS.maxDepth + 1,
    )}`;
    const tooManyNodes = JSON.stringify(
      Array.from({ length: STRICT_JSON_LIMITS.maxNodes }, () => null),
    );

    expect(() => parseStrictJsonBytes(encoder.encode(tooDeep))).toThrow('depth');
    expect(() => parseStrictJsonBytes(encoder.encode(tooManyNodes))).toThrow('node limit');
  });
});
