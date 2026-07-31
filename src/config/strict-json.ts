export const STRICT_JSON_LIMITS = Object.freeze({
  maxArrayEntries: 10_000,
  maxDepth: 32,
  maxNodes: 10_000,
  maxObjectKeys: 256,
});

export type StrictJsonErrorCode =
  'DUPLICATE_KEY' | 'ENCODING' | 'LIMIT' | 'SYNTAX' | 'UNSAFE_VALUE';

export class StrictJsonError extends TypeError {
  readonly code: StrictJsonErrorCode;

  constructor(code: StrictJsonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrictJsonError';
    this.code = code;
  }
}

const forbiddenObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses one security-hardened JSON document from exact UTF-8 bytes.
 *
 * Unlike JSON.parse, this rejects duplicate decoded keys before their first value can be
 * overwritten. The returned graph is subsequently copied into the manifest domain model.
 */
export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array)) {
    throw new StrictJsonError('ENCODING', 'Strict JSON input must be a byte array.');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError('ENCODING', 'Strict JSON must not contain a UTF-8 BOM.');
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new StrictJsonError('ENCODING', 'Strict JSON input is not valid UTF-8.', {
      cause: error,
    });
  }
  if (source.startsWith('\uFEFF')) {
    throw new StrictJsonError('ENCODING', 'Strict JSON must not contain a BOM.');
  }

  new StrictJsonScanner(source).validate();
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new StrictJsonError('SYNTAX', 'Strict JSON input is not valid JSON.', {
      cause: error,
    });
  }
}

class StrictJsonScanner {
  readonly #source: string;
  #index = 0;
  #nodes = 0;

  constructor(source: string) {
    this.#source = source;
  }

  validate(): void {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      this.#syntax('Strict JSON contains trailing content.');
    }
  }

  #parseValue(depth: number): void {
    if (depth > STRICT_JSON_LIMITS.maxDepth) {
      throw new StrictJsonError(
        'LIMIT',
        `Strict JSON exceeds the depth limit of ${String(STRICT_JSON_LIMITS.maxDepth)}.`,
      );
    }
    this.#nodes += 1;
    if (this.#nodes > STRICT_JSON_LIMITS.maxNodes) {
      throw new StrictJsonError(
        'LIMIT',
        `Strict JSON exceeds the node limit of ${String(STRICT_JSON_LIMITS.maxNodes)}.`,
      );
    }

    const character = this.#source[this.#index];
    switch (character) {
      case '{':
        this.#parseObject(depth);
        return;
      case '[':
        this.#parseArray(depth);
        return;
      case '"':
        this.#parseString();
        return;
      case 't':
        this.#parseLiteral('true');
        return;
      case 'f':
        this.#parseLiteral('false');
        return;
      case 'n':
        this.#parseLiteral('null');
        return;
      default:
        if (character === '-' || isDigit(character)) {
          this.#parseNumber();
          return;
        }
        this.#syntax('Strict JSON contains an invalid value.');
    }
  }

  #parseObject(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#consume('}')) {
      return;
    }

    const keys = new Set<string>();
    for (;;) {
      if (keys.size >= STRICT_JSON_LIMITS.maxObjectKeys) {
        throw new StrictJsonError(
          'LIMIT',
          `Strict JSON objects may contain at most ${String(
            STRICT_JSON_LIMITS.maxObjectKeys,
          )} keys.`,
        );
      }
      if (this.#source[this.#index] !== '"') {
        this.#syntax('Strict JSON object keys must be strings.');
      }
      const key = this.#parseString();
      if (forbiddenObjectKeys.has(key)) {
        throw new StrictJsonError('UNSAFE_VALUE', 'Strict JSON contains a forbidden object key.');
      }
      if (keys.has(key)) {
        throw new StrictJsonError('DUPLICATE_KEY', 'Strict JSON contains a duplicate object key.');
      }
      keys.add(key);

      this.#skipWhitespace();
      this.#expect(':', 'Strict JSON object keys must be followed by a colon.');
      this.#skipWhitespace();
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      if (this.#consume('}')) {
        return;
      }
      this.#expect(',', 'Strict JSON object members must be separated by a comma.');
      this.#skipWhitespace();
    }
  }

  #parseArray(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#consume(']')) {
      return;
    }

    let entries = 0;
    for (;;) {
      entries += 1;
      if (entries > STRICT_JSON_LIMITS.maxArrayEntries) {
        throw new StrictJsonError(
          'LIMIT',
          `Strict JSON arrays may contain at most ${String(
            STRICT_JSON_LIMITS.maxArrayEntries,
          )} entries.`,
        );
      }
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      if (this.#consume(']')) {
        return;
      }
      this.#expect(',', 'Strict JSON array entries must be separated by a comma.');
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#expect('"', 'Strict JSON strings must start with a quote.');

    for (;;) {
      if (this.#index >= this.#source.length) {
        this.#syntax('Strict JSON contains an unterminated string.');
      }
      const character = this.#source[this.#index];
      if (character === '"') {
        this.#index += 1;
        break;
      }
      if (character === '\\') {
        this.#index += 1;
        const escape = this.#source[this.#index];
        if (escape === 'u') {
          const digits = this.#source.slice(this.#index + 1, this.#index + 5);
          if (!/^[\da-fA-F]{4}$/u.test(digits)) {
            this.#syntax('Strict JSON contains an invalid Unicode escape.');
          }
          this.#index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          this.#syntax('Strict JSON contains an invalid string escape.');
        }
        this.#index += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.#syntax('Strict JSON strings must not contain unescaped control characters.');
      }
      this.#index += 1;
    }

    let value: string;
    try {
      value = JSON.parse(this.#source.slice(start, this.#index)) as string;
    } catch (error) {
      throw new StrictJsonError('SYNTAX', 'Strict JSON contains an invalid string.', {
        cause: error,
      });
    }
    if (containsLoneSurrogate(value)) {
      throw new StrictJsonError(
        'UNSAFE_VALUE',
        'Strict JSON strings must not contain a lone surrogate.',
      );
    }
    return value;
  }

  #parseNumber(): void {
    const remainder = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remainder);
    const token = match?.[0];
    if (token === undefined) {
      this.#syntax('Strict JSON contains an invalid number.');
    }
    this.#index += token.length;
    if (!isValueDelimiter(this.#source[this.#index])) {
      this.#syntax('Strict JSON contains an invalid number suffix.');
    }

    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new StrictJsonError('UNSAFE_VALUE', 'Strict JSON numbers must be finite.');
    }
    if (Object.is(value, -0)) {
      throw new StrictJsonError('UNSAFE_VALUE', 'Strict JSON must not contain negative zero.');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new StrictJsonError(
        'UNSAFE_VALUE',
        'Strict JSON integer values must be safe integers.',
      );
    }
  }

  #parseLiteral(literal: 'false' | 'null' | 'true'): void {
    if (!this.#source.startsWith(literal, this.#index)) {
      this.#syntax('Strict JSON contains an invalid literal.');
    }
    this.#index += literal.length;
    if (!isValueDelimiter(this.#source[this.#index])) {
      this.#syntax('Strict JSON contains an invalid literal suffix.');
    }
  }

  #skipWhitespace(): void {
    while (
      this.#source[this.#index] === ' ' ||
      this.#source[this.#index] === '\n' ||
      this.#source[this.#index] === '\r' ||
      this.#source[this.#index] === '\t'
    ) {
      this.#index += 1;
    }
  }

  #consume(character: string): boolean {
    if (this.#source[this.#index] !== character) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #expect(character: string, message: string): void {
    if (!this.#consume(character)) {
      this.#syntax(message);
    }
  }

  #syntax(message: string): never {
    throw new StrictJsonError('SYNTAX', `${message} (offset ${String(this.#index)}).`);
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isValueDelimiter(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === ',' ||
    character === '}' ||
    character === ']' ||
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t'
  );
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
