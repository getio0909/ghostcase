import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePortablePath, resolvePortablePath } from '../../src/config/portable-path.js';

describe('portable paths', () => {
  it('accepts canonical relative POSIX paths and the explicit root marker', () => {
    expect(parsePortablePath('fixtures/state', '$.path')).toBe('fixtures/state');
    expect(parsePortablePath('.', '$.path')).toBe('.');
  });

  it.each([
    '',
    '/absolute',
    'C:/absolute',
    'C:relative',
    '\\\\server\\share',
    'one\\two',
    'one//two',
    'one/./two',
    'one/../two',
    'NUL.txt',
    'folder/COM1',
    'trailing.',
    'trailing ',
    'file.json:stream',
    'not\u0000valid',
    'e\u0301',
  ])('rejects a non-portable path: %j', (value) => {
    expect(() => parsePortablePath(value, '$.path')).toThrow('$.path');
  });

  it('resolves only beneath the supplied absolute root', () => {
    const root = resolve('suite-root');

    expect(resolvePortablePath(root, parsePortablePath('fixtures/state', '$.path'))).toBe(
      resolve(root, 'fixtures', 'state'),
    );
    expect(resolvePortablePath(root, parsePortablePath('.', '$.path'))).toBe(root);
  });
});
