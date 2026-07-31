import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';

import { HarnessError } from '../domain/errors.js';

export async function writeOutput(
  destination: string,
  content: string,
  stdout: Writable = process.stdout,
): Promise<void> {
  if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
    throw new TypeError('Output destination must be a non-empty path or "-".');
  }
  if (typeof content !== 'string') {
    throw new TypeError('Output content must be a string.');
  }

  if (destination === '-') {
    await writeToStream(stdout, content);
    return;
  }

  const outputPath = resolve(destination);
  let handle;
  let created = false;
  let operationError: unknown;
  let closeError: unknown;
  try {
    handle = await open(outputPath, 'wx', 0o600);
    created = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      closeError = error;
    }
  }

  if (closeError !== undefined) {
    if (created) {
      await unlink(outputPath).catch(() => undefined);
    }
    throw new HarnessError('Unable to close the output file safely.', { cause: closeError });
  }

  if (operationError !== undefined) {
    if (created) {
      await unlink(outputPath).catch(() => undefined);
    }
    throw new HarnessError(
      'Unable to create the output file; the parent must exist and the target must be new.',
      { cause: operationError },
    );
  }
}

async function writeToStream(stream: Writable, content: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.removeListener('error', onError);
      if (error === null || error === undefined) {
        resolveWrite();
      } else {
        rejectWrite(error);
      }
    };
    const onError = (error: Error): void => {
      finish(error);
    };

    stream.once('error', onError);
    try {
      stream.write(content, 'utf8', finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Unknown stream write failure.'));
    }
  }).catch((error: unknown) => {
    throw new HarnessError('Unable to write command output.', { cause: error });
  });
}
