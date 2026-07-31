import { isAbsolute, relative, resolve } from 'node:path';

import { ConfigError } from '../domain/errors.js';
import type { PortablePath } from '../domain/model.js';

export const PORTABLE_PATH_LIMITS = Object.freeze({
  maxDepth: 32,
  maxPathBytes: 4096,
  maxSegmentBytes: 255,
});

export class PortablePathError extends ConfigError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PortablePathError';
  }
}

export function parsePortablePath(value: unknown, jsonPath: string): PortablePath {
  const source = requirePortableSource(value, jsonPath);
  if (source === '.') {
    return source as PortablePath;
  }
  validatePathShape(source, jsonPath);
  return source as PortablePath;
}

export function resolvePortablePath(root: string, path: PortablePath): string {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !isAbsolute(root)) {
    throw new PortablePathError('Portable path resolution requires an absolute root.');
  }
  const target = path === '.' ? resolve(root) : resolve(root, ...path.split('/'));
  const child = relative(resolve(root), target);
  if (child === '' && path !== '.') {
    throw new PortablePathError('Portable path unexpectedly resolved to its containing root.');
  }
  if (
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(child)
  ) {
    throw new PortablePathError('Portable path resolves outside its containing root.');
  }
  return target;
}

function requirePortableSource(value: unknown, jsonPath: string): string {
  if (typeof value !== 'string') {
    throw new PortablePathError(`${jsonPath} must be a string.`);
  }
  if (value.length === 0) {
    throw new PortablePathError(`${jsonPath} must not be empty.`);
  }
  if (value !== value.normalize('NFC')) {
    throw new PortablePathError(`${jsonPath} must use Unicode NFC normalization.`);
  }
  if (Buffer.byteLength(value, 'utf8') > PORTABLE_PATH_LIMITS.maxPathBytes) {
    throw new PortablePathError(
      `${jsonPath} exceeds the ${String(PORTABLE_PATH_LIMITS.maxPathBytes)}-byte path limit.`,
    );
  }
  return value;
}

function validatePathShape(source: string, jsonPath: string): void {
  if (
    source.includes('\0') ||
    source.includes('\\') ||
    source.startsWith('/') ||
    /^[A-Za-z]:/u.test(source)
  ) {
    throw new PortablePathError(`${jsonPath} must be a normalized relative POSIX path.`);
  }

  const segments = source.split('/');
  if (segments.length > PORTABLE_PATH_LIMITS.maxDepth) {
    throw new PortablePathError(
      `${jsonPath} exceeds the ${String(PORTABLE_PATH_LIMITS.maxDepth)}-segment depth limit.`,
    );
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      /[ .]$/u.test(segment) ||
      containsForbiddenCharacter(segment) ||
      isWindowsDeviceName(segment)
    ) {
      throw new PortablePathError(`${jsonPath} contains a non-portable path segment.`);
    }
    if (Buffer.byteLength(segment, 'utf8') > PORTABLE_PATH_LIMITS.maxSegmentBytes) {
      throw new PortablePathError(
        `${jsonPath} contains a segment exceeding ${String(
          PORTABLE_PATH_LIMITS.maxSegmentBytes,
        )} bytes.`,
      );
    }
  }
}

function containsForbiddenCharacter(segment: string): boolean {
  for (const character of segment) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || '<>:"|?*'.includes(character)) {
      return true;
    }
  }
  return false;
}

function isWindowsDeviceName(segment: string): boolean {
  const basename = segment.split('.')[0]?.trimEnd().toUpperCase() ?? '';
  return /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(basename);
}
