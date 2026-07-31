import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isLinkFreePath } from '../../src/platform/path-safety.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-path-safety-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('isLinkFreePath', () => {
  it('accepts an ordinary path even when Windows realpath expands its DOS alias', async () => {
    const directory = await temporaryDirectory();

    expect(await isLinkFreePath(directory, await realpath(directory))).toBe(true);
  });

  it('rejects a final symbolic link or directory junction', async () => {
    const target = await temporaryDirectory();
    const parent = await temporaryDirectory();
    const linked = join(parent, 'linked');
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await isLinkFreePath(linked, await realpath(linked))).toBe(false);
  });

  it('rejects a known link in an intermediate path component', async () => {
    const target = await temporaryDirectory();
    const nested = join(target, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'state.json'), '{}\n', 'utf8');
    const parent = await temporaryDirectory();
    const linked = join(parent, 'linked');
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const lexicalFile = join(linked, 'nested', 'state.json');

    expect(await isLinkFreePath(lexicalFile, await realpath(lexicalFile))).toBe(false);
  });
});
