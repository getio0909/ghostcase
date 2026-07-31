import { lstat, realpath } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

/**
 * Confirms that a lexical path reaches its real path without a known link component.
 *
 * Windows realpath expands ordinary DOS 8.3 aliases, so spelling inequality alone
 * cannot prove that a link or junction was traversed there.
 */
export async function isLinkFreePath(lexicalPath: string, canonicalPath: string): Promise<boolean> {
  const absolutePath = resolve(lexicalPath);
  if (samePath(absolutePath, canonicalPath)) {
    return true;
  }
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const root = parse(absolutePath).root;
    let cursor = absolutePath;
    for (;;) {
      if ((await lstat(cursor)).isSymbolicLink()) {
        return false;
      }
      if (samePath(cursor, root)) {
        break;
      }
      const parent = dirname(cursor);
      if (samePath(parent, cursor)) {
        return false;
      }
      cursor = parent;
    }

    return samePath(await realpath(absolutePath), canonicalPath);
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
