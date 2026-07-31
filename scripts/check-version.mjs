#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const versionSource = await readFile(new URL('src/version.ts', root), 'utf8');
const expected = `export const version = '${manifest.version}' as const;\n`;

if (versionSource !== expected) {
  process.stderr.write('package.json and src/version.ts versions differ.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`Version ${manifest.version} is synchronized.\n`);
}
