import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { FixtureError, HarnessError, isNodeError } from '../domain/errors.js';
import { isLinkFreePath } from '../platform/path-safety.js';
import type { SeedEntry, SeedFile, SeedSnapshot } from './seed.js';

export interface MaterializeOptions {
  readonly prefix?: string;
  readonly temporaryRoot: string;
}

export interface MaterializedWorkspace {
  readonly cleanup: () => Promise<void>;
  readonly root: string;
}

export async function materializeSeed(
  snapshot: SeedSnapshot,
  options: MaterializeOptions,
): Promise<MaterializedWorkspace> {
  const prefix = options.prefix ?? 'ghostcase-arm-';
  validatePrefix(prefix);
  const temporaryRoot = await validateTemporaryRoot(options.temporaryRoot);
  let created: string | undefined;

  try {
    created = await mkdtemp(join(temporaryRoot, prefix));
    const canonicalCreated = await realpath(created);
    assertTemporaryChild(canonicalCreated, temporaryRoot, prefix);
    await writeEntries(canonicalCreated, snapshot.entries);
    let cleaned = false;
    return {
      cleanup: async (): Promise<void> => {
        if (cleaned) {
          return;
        }
        await removeWorkspace(canonicalCreated, temporaryRoot, prefix);
        cleaned = true;
      },
      root: canonicalCreated,
    };
  } catch (error) {
    if (created !== undefined) {
      await removeWorkspaceAfterFailure(created, temporaryRoot, prefix);
    }
    if (error instanceof FixtureError || error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError('Unable to materialize an isolated workspace.', { cause: error });
  }
}

async function writeEntries(root: string, entries: readonly SeedEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = resolveWorkspacePath(root, entry.path);
    if (entry.type === 'directory') {
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        throw new HarnessError('Unable to create an isolated workspace directory.', {
          cause: error,
        });
      }
      continue;
    }
    await writeFileEntry(target, entry);
  }
}

async function writeFileEntry(target: string, entry: SeedFile): Promise<void> {
  const content = Buffer.from(entry.contentBase64, 'base64');
  if (
    content.length !== entry.size ||
    createHash('sha256').update(content).digest('hex') !== entry.sha256
  ) {
    throw new FixtureError('The in-memory seed snapshot failed its integrity check.');
  }

  let handle;
  try {
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
    handle = await open(target, 'wx', entry.executable ? 0o700 : 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    throw new HarnessError('Unable to write an isolated workspace file.', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (process.platform !== 'win32') {
    try {
      await chmod(target, entry.executable ? 0o700 : 0o600);
    } catch (error) {
      throw new HarnessError('Unable to set isolated workspace file permissions.', {
        cause: error,
      });
    }
  }
}

async function validateTemporaryRoot(root: string): Promise<string> {
  const lexical = resolve(root);
  let metadata;
  try {
    metadata = await lstat(lexical);
  } catch (error) {
    throw new HarnessError('Unable to inspect the temporary workspace root.', { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new HarnessError('The temporary workspace root must be a regular directory.');
  }
  let canonical;
  try {
    canonical = await realpath(lexical);
  } catch (error) {
    throw new HarnessError('Unable to resolve the temporary workspace root.', { cause: error });
  }
  if (!(await isLinkFreePath(lexical, canonical))) {
    throw new HarnessError('The temporary workspace root resolves through a link.');
  }
  return canonical;
}

function resolveWorkspacePath(root: string, portablePath: string): string {
  const segments = portablePath.split('/');
  if (
    portablePath.length === 0 ||
    portablePath.includes('\0') ||
    portablePath.includes('\\') ||
    portablePath.startsWith('/') ||
    /^[a-zA-Z]:/u.test(portablePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new FixtureError('The seed snapshot contains an unsafe relative path.');
  }
  const target = resolve(root, ...segments);
  const child = relative(root, target);
  if (child === '' || child.startsWith('..') || isAbsolute(child)) {
    throw new FixtureError('The seed snapshot path escapes the isolated workspace.');
  }
  return target;
}

async function removeWorkspace(path: string, temporaryRoot: string, prefix: string): Promise<void> {
  assertTemporaryChild(path, temporaryRoot, prefix);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw new HarnessError('Unable to inspect an isolated workspace during cleanup.', {
      cause: error,
    });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new HarnessError('Refusing to clean an isolated workspace whose root changed type.');
  }
  let canonical;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new HarnessError('Unable to resolve an isolated workspace during cleanup.', {
      cause: error,
    });
  }
  if (!(await isLinkFreePath(path, canonical))) {
    throw new HarnessError('Refusing to clean an isolated workspace that became a link.');
  }
  try {
    await rm(path, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  } catch (error) {
    throw new HarnessError('Unable to clean an isolated workspace.', { cause: error });
  }
}

async function removeWorkspaceAfterFailure(
  path: string,
  temporaryRoot: string,
  prefix: string,
): Promise<void> {
  try {
    const canonical = await realpath(path);
    await removeWorkspace(canonical, temporaryRoot, prefix);
  } catch {
    // The original materialization error remains authoritative. Unsafe cleanup is refused.
  }
}

function assertTemporaryChild(path: string, temporaryRoot: string, prefix: string): void {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  if (
    !samePath(dirname(path), temporaryRoot) ||
    !base.startsWith(prefix) ||
    base.length <= prefix.length
  ) {
    throw new HarnessError('Refusing to operate on an unexpected workspace path.');
  }
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length < 3 ||
    prefix.length > 64 ||
    prefix.includes('\0') ||
    prefix.includes('/') ||
    prefix.includes('\\') ||
    prefix === '.' ||
    prefix === '..'
  ) {
    throw new HarnessError('The temporary workspace prefix is invalid.');
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
