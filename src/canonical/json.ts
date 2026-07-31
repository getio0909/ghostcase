import { createHash } from 'node:crypto';

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return encode(value, new WeakSet<object>());
}

export function canonicalSha256(domain: string, value: CanonicalJsonValue): string {
  if (domain.length === 0 || domain.includes('\0')) {
    throw new CanonicalJsonError(
      'The canonical digest domain must be non-empty and contain no NUL.',
    );
  }
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function encode(value: CanonicalJsonValue, active: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new CanonicalJsonError('Canonical JSON numbers must be finite and must not be -0.');
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new CanonicalJsonError('Canonical JSON integers must be safe integers.');
      }
      return JSON.stringify(value);
    case 'string':
      assertNoLoneSurrogate(value);
      return JSON.stringify(value);
    case 'object':
      return encodeObject(value, active);
  }
}

function encodeObject(value: object, active: WeakSet<object>): string {
  if (active.has(value)) {
    throw new CanonicalJsonError('Canonical JSON must not contain cycles.');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const array = value as readonly CanonicalJsonValue[];
      return `[${array.map((entry) => encode(entry, active)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Canonical JSON objects must have a plain or null prototype.');
    }
    const record = value as Readonly<Record<string, CanonicalJsonValue>>;
    const keys = Object.keys(record).sort(compareUtf8);
    const properties = keys.map((key) => {
      assertNoLoneSurrogate(key);
      const entry = record[key];
      if (entry === undefined) {
        throw new CanonicalJsonError('Canonical JSON object values must not be undefined.');
      }
      return `${JSON.stringify(key)}:${encode(entry, active)}`;
    });
    return `{${properties.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertNoLoneSurrogate(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError('Canonical JSON strings must not contain lone surrogates.');
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('Canonical JSON strings must not contain lone surrogates.');
    }
  }
}
