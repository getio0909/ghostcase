export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export interface JsonPointerFound {
  readonly found: true;
  readonly value: JsonValue;
}

export interface JsonPointerMissing {
  readonly found: false;
}

export type JsonPointerResult = JsonPointerFound | JsonPointerMissing;

const MAX_JSON_DEPTH = 128;
const MAX_VALIDATED_JSON_NODES = 100_000;

export class StrictJsonError extends SyntaxError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrictJsonError';
  }
}

export class JsonPointerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonPointerError';
  }
}

class StrictJsonParser {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): JsonValue {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      throw this.#syntaxError('Expected end of input');
    }
    return value;
  }

  #parseValue(depth: number): JsonValue {
    if (depth > MAX_JSON_DEPTH) {
      throw this.#syntaxError(`JSON nesting exceeds the limit of ${String(MAX_JSON_DEPTH)}`);
    }

    const character = this.#source[this.#index];
    switch (character) {
      case '"':
        return this.#parseString();
      case '[':
        return this.#parseArray(depth + 1);
      case '{':
        return this.#parseObject(depth + 1);
      case 'f':
        this.#consumeLiteral('false');
        return false;
      case 'n':
        this.#consumeLiteral('null');
        return null;
      case 't':
        this.#consumeLiteral('true');
        return true;
      default:
        if (character === '-' || isAsciiDigit(character)) {
          return this.#parseNumber();
        }
        throw this.#syntaxError('Expected a JSON value');
    }
  }

  #parseArray(depth: number): JsonArray {
    this.#index += 1;
    this.#skipWhitespace();

    const values: JsonValue[] = [];
    if (this.#source[this.#index] === ']') {
      this.#index += 1;
      return values;
    }

    for (;;) {
      values.push(this.#parseValue(depth));
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === ']') {
        this.#index += 1;
        return values;
      }
      if (separator !== ',') {
        throw this.#syntaxError('Expected "," or "]"');
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseObject(depth: number): JsonObject {
    this.#index += 1;
    this.#skipWhitespace();

    const value = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    if (this.#source[this.#index] === '}') {
      this.#index += 1;
      return value;
    }

    for (;;) {
      if (this.#source[this.#index] !== '"') {
        throw this.#syntaxError('Expected an object key');
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new StrictJsonError(`Duplicate object key ${JSON.stringify(key)}.`);
      }
      keys.add(key);

      this.#skipWhitespace();
      if (this.#source[this.#index] !== ':') {
        throw this.#syntaxError('Expected ":" after an object key');
      }
      this.#index += 1;
      this.#skipWhitespace();
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: this.#parseValue(depth),
        writable: true,
      });

      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === '}') {
        this.#index += 1;
        return value;
      }
      if (separator !== ',') {
        throw this.#syntaxError('Expected "," or "}"');
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    this.#index += 1;
    let value = '';

    while (this.#index < this.#source.length) {
      const character = this.#source.charAt(this.#index);
      const code = character.charCodeAt(0);

      if (character === '"') {
        this.#index += 1;
        return value;
      }

      if (character === '\\') {
        this.#index += 1;
        value += this.#parseEscape();
        continue;
      }

      if (code < 0x20) {
        throw this.#syntaxError('Unescaped control character in string');
      }

      if (isHighSurrogate(code)) {
        const next = this.#source.charCodeAt(this.#index + 1);
        if (!isLowSurrogate(next)) {
          throw this.#syntaxError('Unpaired high surrogate in string');
        }
        value += character + this.#source.charAt(this.#index + 1);
        this.#index += 2;
        continue;
      }

      if (isLowSurrogate(code)) {
        throw this.#syntaxError('Unpaired low surrogate in string');
      }

      value += character;
      this.#index += 1;
    }

    throw this.#syntaxError('Unterminated string');
  }

  #parseEscape(): string {
    const escape = this.#source[this.#index];
    this.#index += 1;

    switch (escape) {
      case '"':
      case '/':
      case '\\':
        return escape;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.#parseUnicodeEscape();
      default:
        throw this.#syntaxError('Invalid string escape');
    }
  }

  #parseUnicodeEscape(): string {
    const first = this.#parseHexCodeUnit();
    if (isLowSurrogate(first)) {
      throw this.#syntaxError('Unpaired low surrogate escape');
    }
    if (!isHighSurrogate(first)) {
      return String.fromCharCode(first);
    }

    if (this.#source[this.#index] !== '\\' || this.#source[this.#index + 1] !== 'u') {
      throw this.#syntaxError('Unpaired high surrogate escape');
    }
    this.#index += 2;
    const second = this.#parseHexCodeUnit();
    if (!isLowSurrogate(second)) {
      throw this.#syntaxError('Unpaired high surrogate escape');
    }
    return String.fromCharCode(first, second);
  }

  #parseHexCodeUnit(): number {
    const digits = this.#source.slice(this.#index, this.#index + 4);
    if (!/^[\dA-Fa-f]{4}$/u.test(digits)) {
      throw this.#syntaxError('Invalid Unicode escape');
    }
    this.#index += 4;
    return Number.parseInt(digits, 16);
  }

  #parseNumber(): number {
    const remaining = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?/u.exec(remaining);
    if (match === null) {
      throw this.#syntaxError('Invalid JSON number');
    }

    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw this.#syntaxError('JSON number must be finite');
    }
    return value;
  }

  #consumeLiteral(literal: 'false' | 'null' | 'true'): void {
    if (!this.#source.startsWith(literal, this.#index)) {
      throw this.#syntaxError(`Expected ${literal}`);
    }
    this.#index += literal.length;
  }

  #skipWhitespace(): void {
    while (isJsonWhitespace(this.#source[this.#index])) {
      this.#index += 1;
    }
  }

  #syntaxError(message: string): StrictJsonError {
    return new StrictJsonError(`${message} at character ${String(this.#index)}.`);
  }
}

export function parseStrictJson(source: string): JsonValue {
  return new StrictJsonParser(source).parse();
}

export function validateJsonPointer(pointer: string): void {
  decodePointer(pointer);
}

export function resolveJsonPointer(document: JsonValue, pointer: string): JsonPointerResult {
  const tokens = decodePointer(pointer);
  let current = document;

  for (const token of tokens) {
    if (isJsonArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        return { found: false };
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return { found: false };
      }
      const next = current[index];
      if (next === undefined) {
        return { found: false };
      }
      current = next;
      continue;
    }

    if (isJsonObject(current) && Object.hasOwn(current, token)) {
      const next = current[token];
      if (next === undefined) {
        return { found: false };
      }
      current = next;
      continue;
    }

    return { found: false };
  }

  return { found: true, value: current };
}

export function jsonDeepEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }

  if (isJsonArray(left)) {
    if (!isJsonArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => {
      const rightValue = right[index];
      return rightValue !== undefined && jsonDeepEqual(value, rightValue);
    });
  }

  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return (
      leftValue !== undefined && rightValue !== undefined && jsonDeepEqual(leftValue, rightValue)
    );
  });
}

export function assertJsonValue(value: unknown, label = 'value'): asserts value is JsonValue {
  const state = {
    active: new WeakSet<object>(),
    nodes: 0,
  };
  assertJsonValueAt(value, label, 0, state);
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = value[key];
      if (item === undefined) {
        throw new TypeError('JSON object contains an undefined value.');
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(item)}`;
    })
    .join(',')}}`;
}

function decodePointer(pointer: string): readonly string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new JsonPointerError('A JSON Pointer must be empty or start with "/".');
  }

  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      let decoded = '';
      for (let index = 0; index < token.length; index += 1) {
        const character = token.charAt(index);
        if (character !== '~') {
          decoded += character;
          continue;
        }

        const escape = token[index + 1];
        if (escape === '0') {
          decoded += '~';
        } else if (escape === '1') {
          decoded += '/';
        } else {
          throw new JsonPointerError('A JSON Pointer contains an invalid "~" escape.');
        }
        index += 1;
      }
      return decoded;
    });
}

function assertJsonValueAt(
  value: unknown,
  label: string,
  depth: number,
  state: { readonly active: WeakSet<object>; nodes: number },
): asserts value is JsonValue {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_VALIDATED_JSON_NODES) {
    throw new TypeError(`${label} exceeds the JSON complexity limit.`);
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') {
      assertUnicodeScalarString(value, label);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must contain only finite JSON numbers.`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  if (state.active.has(value)) {
    throw new TypeError(`${label} must not contain a cycle.`);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${label} must not contain sparse or accessor array elements.`);
        }
        assertJsonValueAt(descriptor.value, `${label}[${String(index)}]`, depth + 1, state);
      }
      const extraKeys = Object.keys(descriptors).filter(
        (key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key),
      );
      if (extraKeys.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`${label} must not contain non-JSON array properties.`);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain JSON objects.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${label} must not contain symbol properties.`);
    }

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      assertUnicodeScalarString(key, `${label} object key`);
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label} must contain only enumerable data properties.`);
      }
      assertJsonValueAt(descriptor.value, `${label}.${key}`, depth + 1, state);
    }
  } finally {
    state.active.delete(value);
  }
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = value.charCodeAt(index + 1);
      if (!isLowSurrogate(next)) {
        throw new TypeError(`${label} contains an unpaired surrogate.`);
      }
      index += 1;
    } else if (isLowSurrogate(code)) {
      throw new TypeError(`${label} contains an unpaired surrogate.`);
    }
  }
}

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}
