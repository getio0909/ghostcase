import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJson, type CanonicalJsonValue } from '../canonical/index.js';
import { loadManifest, parseStrictJsonBytes } from '../config/index.js';
import { errorMessage, EvidenceError, isNodeError } from '../domain/errors.js';
import type { LoadedManifest } from '../domain/model.js';
import { validateReport, type GhostCaseReport } from '../report/index.js';
import { prepareSuite, type PreparedSuite } from '../workspace/index.js';
import {
  captureExecutionDependencies,
  executionDependenciesEqual,
} from './execution-dependencies.js';
import {
  GHOSTCASE_EVIDENCE_SCHEMA,
  createEvidence,
  validateEvidence,
  validateEvidenceLocator,
  type GhostCaseEvidence,
} from './model.js';

export const EVIDENCE_FILE_MAX_BYTES = 1024 * 1024;

export interface StoreEvidenceOptions {
  readonly evidenceDir: string;
  readonly manifest: LoadedManifest;
  readonly prepared: PreparedSuite;
  readonly report: GhostCaseReport;
}

export interface StoredEvidence {
  readonly evidence: GhostCaseEvidence;
  readonly path: string;
  readonly sha256: string;
}

export interface LoadedEvidence {
  readonly evidence: GhostCaseEvidence;
  readonly manifest: LoadedManifest;
  readonly prepared: PreparedSuite;
  readonly sourcePath: string;
}

export interface EvidenceFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface EvidenceWriteHandle {
  close(): Promise<void>;
  identity(): Promise<EvidenceFileIdentity>;
  sync(): Promise<void>;
  writeFile(bytes: Buffer): Promise<void>;
}

export interface EvidenceWriteOperations {
  openExclusive(sourcePath: string): Promise<EvidenceWriteHandle>;
  readVerified(sourcePath: string): Promise<{
    readonly bytes: Buffer;
    readonly identity: EvidenceFileIdentity;
  }>;
  removeIfSame(sourcePath: string, identity: EvidenceFileIdentity): Promise<void>;
}

interface ReadEvidenceFileResult {
  readonly bytes: Buffer;
  readonly identity: EvidenceFileIdentity;
  readonly sourcePath: string;
}

export async function storeEvidence(options: StoreEvidenceOptions): Promise<StoredEvidence> {
  const report = validateReport(options.report);
  assertReportMatchesManifest(report, options.manifest);
  const currentManifest = await assertManifestIsCurrent(options.manifest);
  const [currentPrepared, executionDependencies] = await Promise.all([
    prepareSuiteForEvidence(currentManifest, 'before evidence could be stored'),
    captureExecutionDependencies(currentManifest),
  ]);
  assertPreparedMatches(options.prepared, currentPrepared);

  const evidenceDir = await prepareEvidenceDirectory(options.evidenceDir);
  const locator = portableRelative(evidenceDir, options.manifest.sourcePath);
  const evidence = createEvidence({
    report,
    schema: GHOSTCASE_EVIDENCE_SCHEMA,
    suite: {
      executionDependencies,
      locator,
      preparedSeedSha256: currentPrepared.snapshot.digest,
      sourceSha256: options.manifest.sourceSha256,
    },
    toolVersion: report.toolVersion,
  });
  const bytes = Buffer.from(canonicalJson(evidence as unknown as CanonicalJsonValue), 'utf8');
  if (bytes.length > EVIDENCE_FILE_MAX_BYTES) {
    throw new EvidenceError(
      `Evidence exceeds the ${String(EVIDENCE_FILE_MAX_BYTES)}-byte file limit.`,
    );
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sourcePath = join(
    evidenceDir,
    `${options.manifest.definition.suite.id}-${sha256.slice(0, 12)}.json`,
  );
  await writeExclusiveOrConfirm(sourcePath, bytes);
  return Object.freeze({
    evidence,
    path: sourcePath,
    sha256,
  });
}

export async function loadEvidence(evidencePath: string): Promise<LoadedEvidence> {
  const { bytes, sourcePath } = await readEvidenceFile(evidencePath);

  let evidence: GhostCaseEvidence;
  try {
    evidence = validateEvidence(parseStrictJsonBytes(bytes));
  } catch (error) {
    throw new EvidenceError(`Evidence file is not a valid ${GHOSTCASE_EVIDENCE_SCHEMA} document.`, {
      cause: error,
    });
  }

  const manifestPath = resolveEvidenceLocator(dirname(sourcePath), evidence.suite.locator);
  let manifest: LoadedManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    throw new EvidenceError('Evidence suite locator could not load its manifest.', {
      cause: error,
    });
  }
  if (
    manifest.sourceSha256 !== evidence.suite.sourceSha256 ||
    manifest.sourceSha256 !== evidence.report.suite.sourceSha256
  ) {
    throw new EvidenceError('Evidence is stale because the suite source digest changed.');
  }
  if (manifest.definition.suite.id !== evidence.report.suite.id) {
    throw new EvidenceError('Evidence suite ID does not match the located manifest.');
  }
  const [prepared, executionDependencies] = await Promise.all([
    prepareSuiteForEvidence(manifest, 'while evidence was loaded'),
    captureExecutionDependencies(manifest),
  ]);
  if (prepared.snapshot.digest !== evidence.suite.preparedSeedSha256) {
    throw new EvidenceError('Evidence is stale because the prepared seed digest changed.');
  }
  if (!executionDependenciesEqual(executionDependencies, evidence.suite.executionDependencies)) {
    throw new EvidenceError(
      'Evidence is stale because a direct suite execution dependency changed.',
    );
  }

  return Object.freeze({
    evidence,
    manifest,
    prepared,
    sourcePath,
  });
}

function assertReportMatchesManifest(report: GhostCaseReport, manifest: LoadedManifest): void {
  if (
    report.suite.id !== manifest.definition.suite.id ||
    report.suite.sourceSha256 !== manifest.sourceSha256
  ) {
    throw new EvidenceError('Report suite identity does not match the loaded manifest.');
  }
}

async function assertManifestIsCurrent(manifest: LoadedManifest): Promise<LoadedManifest> {
  let current: LoadedManifest;
  try {
    current = await loadManifest(manifest.sourcePath);
  } catch (error) {
    throw new EvidenceError('The manifest could not be revalidated before storing evidence.', {
      cause: error,
    });
  }
  if (
    current.sourceSha256 !== manifest.sourceSha256 ||
    current.definition.suite.id !== manifest.definition.suite.id
  ) {
    throw new EvidenceError('The manifest changed before evidence could be stored.');
  }
  return current;
}

async function prepareSuiteForEvidence(
  manifest: LoadedManifest,
  phase: string,
): Promise<PreparedSuite> {
  try {
    return await prepareSuite(manifest);
  } catch (error) {
    throw new EvidenceError(`The prepared seed could not be validated ${phase}.`, {
      cause: error,
    });
  }
}

function assertPreparedMatches(supplied: PreparedSuite, current: PreparedSuite): void {
  let suppliedDigest: unknown;
  try {
    suppliedDigest = supplied.snapshot.digest;
  } catch (error) {
    throw new EvidenceError('The supplied prepared seed is not inspectable.', { cause: error });
  }
  if (
    typeof suppliedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(suppliedDigest) ||
    suppliedDigest !== current.snapshot.digest
  ) {
    throw new EvidenceError(
      'The supplied prepared seed digest does not match the current manifest inputs.',
    );
  }
}

async function prepareEvidenceDirectory(requestedPath: string): Promise<string> {
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.length === 0 ||
    requestedPath.includes('\0')
  ) {
    throw new EvidenceError('Evidence directory must be a non-empty path without NUL.');
  }
  const absolutePath = resolve(requestedPath);
  try {
    await mkdir(absolutePath, { recursive: true });
    const before = await lstat(absolutePath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new EvidenceError('Evidence directory must be a real directory, not a link.');
    }
    const canonical = await realpath(absolutePath);
    if (!samePath(absolutePath, canonical)) {
      throw new EvidenceError('Evidence directory must not be a symbolic link.');
    }
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameDirectorySnapshot(before, after)) {
      throw new EvidenceError('Evidence directory changed while it was inspected.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    throw new EvidenceError(`Unable to prepare evidence directory: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function portableRelative(fromDirectory: string, targetPath: string): string {
  if (!isAbsolute(fromDirectory) || !isAbsolute(targetPath)) {
    throw new EvidenceError('Evidence paths must be absolute after canonicalization.');
  }
  const candidate = relative(fromDirectory, targetPath).replaceAll('\\', '/');
  try {
    return validateEvidenceLocator(candidate, '$.suite.locator');
  } catch (error) {
    throw new EvidenceError(
      'Manifest cannot be represented by a portable path relative to the evidence directory.',
      { cause: error },
    );
  }
}

function resolveEvidenceLocator(evidenceDir: string, locator: string): string {
  const validated = validateEvidenceLocator(locator);
  return resolve(evidenceDir, ...validated.split('/'));
}

export async function writeExclusiveOrConfirm(
  sourcePath: string,
  bytes: Buffer,
  operations: EvidenceWriteOperations = defaultWriteOperations,
): Promise<void> {
  let handle: EvidenceWriteHandle;
  try {
    handle = await operations.openExclusive(sourcePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      const existing = await operations.readVerified(sourcePath);
      if (existing.bytes.equals(bytes)) {
        return;
      }
      throw new EvidenceError(
        'Content-addressed evidence filename already exists with different bytes.',
        { cause: error },
      );
    }
    throw new EvidenceError(`Unable to write evidence file: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let identity: EvidenceFileIdentity | undefined;
  let failure: unknown;
  try {
    identity = await handle.identity();
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }

  if (failure === undefined && identity !== undefined) {
    try {
      const verified = await operations.readVerified(sourcePath);
      if (!sameFileIdentity(identity, verified.identity) || !verified.bytes.equals(bytes)) {
        failure = new Error('Evidence verification did not match the written bytes.');
      }
    } catch (error) {
      failure = error;
    }
  }

  if (failure !== undefined || identity === undefined) {
    if (identity !== undefined) {
      await operations.removeIfSame(sourcePath, identity).catch(() => undefined);
    }
    throw new EvidenceError('Evidence file did not complete sync, close, and verification.', {
      cause: failure,
    });
  }
}

async function readEvidenceFile(requestedPath: string): Promise<ReadEvidenceFileResult> {
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.length === 0 ||
    requestedPath.includes('\0')
  ) {
    throw new EvidenceError('Evidence path must be a non-empty path without NUL.');
  }
  const sourcePath = resolve(requestedPath);
  let before: BigIntStats;
  let canonical: string;
  try {
    before = await lstat(sourcePath, { bigint: true });
    canonical = await realpath(sourcePath);
  } catch (error) {
    throw new EvidenceError(`Unable to inspect evidence file: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!before.isFile() || before.isSymbolicLink() || !samePath(sourcePath, canonical)) {
    throw new EvidenceError('Evidence path must be a regular non-link file.');
  }
  if (before.size > BigInt(EVIDENCE_FILE_MAX_BYTES)) {
    throw evidenceSizeError();
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(sourcePath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      throw new EvidenceError('Evidence file changed before it could be read.');
    }

    const bytes = await readBounded(handle);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(before, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw new EvidenceError('Evidence file changed while it was read.');
    }
    return {
      bytes,
      identity: fileIdentity(before),
      sourcePath: canonical,
    };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    throw new EvidenceError(`Unable to read evidence file: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(EVIDENCE_FILE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
    if (offset > EVIDENCE_FILE_MAX_BYTES) {
      throw evidenceSizeError();
    }
  }
  return Buffer.from(buffer.subarray(0, offset));
}

function evidenceSizeError(): EvidenceError {
  return new EvidenceError(
    `Evidence file exceeds the ${String(EVIDENCE_FILE_MAX_BYTES)}-byte limit.`,
  );
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.isDirectory() &&
    !right.isSymbolicLink()
  );
}

function fileIdentity(stats: BigIntStats): EvidenceFileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
  });
}

function sameFileIdentity(left: EvidenceFileIdentity, right: EvidenceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const defaultWriteOperations: EvidenceWriteOperations = Object.freeze({
  openExclusive: async (sourcePath: string): Promise<EvidenceWriteHandle> => {
    const handle = await open(sourcePath, 'wx', 0o600);
    return fileHandleAdapter(handle);
  },
  readVerified: async (
    sourcePath: string,
  ): Promise<{ readonly bytes: Buffer; readonly identity: EvidenceFileIdentity }> => {
    const result = await readEvidenceFile(sourcePath);
    return {
      bytes: result.bytes,
      identity: result.identity,
    };
  },
  removeIfSame: async (
    sourcePath: string,
    expectedIdentity: EvidenceFileIdentity,
  ): Promise<void> => {
    let current: BigIntStats;
    try {
      current = await lstat(sourcePath, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(expectedIdentity, fileIdentity(current))
    ) {
      return;
    }
    await unlink(sourcePath);
  },
});

function fileHandleAdapter(handle: FileHandle): EvidenceWriteHandle {
  return {
    close: async (): Promise<void> => handle.close(),
    identity: async (): Promise<EvidenceFileIdentity> =>
      fileIdentity(await handle.stat({ bigint: true })),
    sync: async (): Promise<void> => handle.sync(),
    writeFile: async (bytes: Buffer): Promise<void> => handle.writeFile(bytes),
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
