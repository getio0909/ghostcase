import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { HarnessError } from '../../src/domain/errors.js';
import { writeOutput } from '../../src/cli/write-output.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostcase-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('writeOutput', () => {
  it('writes stdout through the supplied stream', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    await writeOutput('-', 'result\n', stream);

    expect(Buffer.concat(chunks).toString('utf8')).toBe('result\n');
  });

  it('creates a new private output file', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'report.json');

    await writeOutput(destination, '{"ok":true}\n');

    expect(await readFile(destination, 'utf8')).toBe('{"ok":true}\n');
    if (process.platform !== 'win32') {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite an existing file', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'report.json');
    await writeFile(destination, 'owned by caller', 'utf8');

    await expect(writeOutput(destination, 'replacement')).rejects.toBeInstanceOf(HarnessError);
    expect(await readFile(destination, 'utf8')).toBe('owned by caller');
  });

  it.each(['', 'bad\0path'])('rejects an invalid destination', async (destination) => {
    await expect(writeOutput(destination, 'content')).rejects.toThrow(TypeError);
  });

  it('reports a stream failure without exposing the destination', async () => {
    const stream = new PassThrough();
    stream.destroy(new Error('synthetic failure'));

    await expect(writeOutput('-', 'content', stream)).rejects.toMatchObject({
      code: 'HARNESS_ERROR',
      message: 'Unable to write command output.',
    });
  });
});
