import { createHash, type Hash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { resolvePortablePath } from '../config/index.js';
import { EvidenceError } from '../domain/errors.js';
import type {
  CommandSpec,
  EnvironmentPatch,
  LoadedManifest,
  PortablePath,
  ProgramSpec,
  RunPatch,
  StdinSpec,
  ValueSpec,
  WorkingDirectorySpec,
} from '../domain/model.js';
import { isLinkFreePath } from '../platform/path-safety.js';
import type { OracleSpec } from '../oracle/index.js';
import {
  GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
  type EvidenceExecutionDependencies,
} from './model.js';

type DependencyRole = 'program' | 'stdin' | 'value';

interface DependencyReference {
  readonly path: PortablePath;
  readonly roles: ReadonlySet<DependencyRole>;
}

interface DependencyFileDigest {
  readonly contentSha256: string;
  readonly executable: boolean;
  readonly size: bigint;
}

interface InspectedDependencyFile {
  readonly absolutePath: string;
  readonly before: BigIntStats;
  readonly canonicalPath: string;
}

interface ReferenceCollection {
  readonly dynamicPathReferences: ReadonlySet<string>;
  readonly dynamicStdinFiles: ReadonlySet<string>;
  readonly lookupPrograms: ReadonlySet<string>;
  readonly suiteFiles: ReadonlyMap<PortablePath, ReadonlySet<DependencyRole>>;
}

export interface ExecutionDependencyLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_EXECUTION_DEPENDENCY_LIMITS: Readonly<ExecutionDependencyLimits> =
  Object.freeze({
    maxFileBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
  });

/**
 * Commits the direct, portable execution files that GhostCase can validate without pretending to
 * resolve an executable's recursive imports or mutable host dependencies.
 */
export async function captureExecutionDependencies(
  manifest: LoadedManifest,
  requestedLimits: Readonly<ExecutionDependencyLimits> = DEFAULT_EXECUTION_DEPENDENCY_LIMITS,
): Promise<EvidenceExecutionDependencies> {
  const limits = validateLimits(requestedLimits);
  const references = collectReferences(manifest);
  const referencedFiles = [...references.suiteFiles.entries()]
    .map(([path, roles]): DependencyReference => ({ path, roles }))
    .sort((left, right) => compareUtf8(left.path, right.path));

  const inspected: {
    readonly file: DependencyReference;
    readonly snapshot: InspectedDependencyFile;
  }[] = [];
  let totalBytes = 0n;
  let unboundSuitePathReferences = 0;
  for (const file of referencedFiles) {
    const absolutePath = resolvePortablePath(manifest.suiteDir, file.path);
    let snapshot: InspectedDependencyFile;
    try {
      snapshot = await inspectSuiteFile(manifest.suiteDir, absolutePath);
    } catch (error) {
      if (file.roles.has('program') || file.roles.has('stdin')) {
        throw error;
      }
      unboundSuitePathReferences += 1;
      continue;
    }
    if (snapshot.before.size > BigInt(limits.maxFileBytes)) {
      throw new EvidenceError(
        `A direct suite execution dependency exceeds the ${String(
          limits.maxFileBytes,
        )}-byte file limit.`,
      );
    }
    totalBytes += snapshot.before.size;
    if (totalBytes > BigInt(limits.maxTotalBytes)) {
      throw new EvidenceError(
        `Direct suite execution dependencies exceed the ${String(
          limits.maxTotalBytes,
        )}-byte total limit.`,
      );
    }
    inspected.push({ file, snapshot });
  }

  const digest = createHash('sha256');
  digest.update(`${GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA}\0`, 'utf8');
  updateInteger(digest, inspected.length);
  updateInteger(digest, references.lookupPrograms.size);
  updateInteger(digest, references.dynamicStdinFiles.size);
  updateInteger(digest, references.dynamicPathReferences.size);
  updateInteger(digest, unboundSuitePathReferences);

  for (const { file, snapshot: inspectedFile } of inspected) {
    const snapshot = await digestStableSuiteFile(inspectedFile);
    updateText(digest, file.path);
    updateText(digest, [...file.roles].sort(compareUtf8).join(','));
    updateBigInteger(digest, snapshot.size);
    digest.update(snapshot.executable ? Buffer.from([1]) : Buffer.from([0]));
    updateText(digest, snapshot.contentSha256);
  }

  return Object.freeze({
    boundSuiteFiles: inspected.length,
    schema: GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
    sha256: digest.digest('hex'),
    unboundDynamicPathReferences: references.dynamicPathReferences.size,
    unboundDynamicStdinFiles: references.dynamicStdinFiles.size,
    unboundLookupPrograms: references.lookupPrograms.size,
    unboundSuitePathReferences,
  });
}

export function executionDependenciesEqual(
  left: EvidenceExecutionDependencies,
  right: EvidenceExecutionDependencies,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.boundSuiteFiles === right.boundSuiteFiles &&
    left.unboundLookupPrograms === right.unboundLookupPrograms &&
    left.unboundDynamicStdinFiles === right.unboundDynamicStdinFiles &&
    left.unboundDynamicPathReferences === right.unboundDynamicPathReferences &&
    left.unboundSuitePathReferences === right.unboundSuitePathReferences
  );
}

function collectReferences(manifest: LoadedManifest): ReferenceCollection {
  const suiteFiles = new Map<PortablePath, Set<DependencyRole>>();
  const lookupPrograms = new Set<string>();
  const dynamicStdinFiles = new Set<string>();
  const dynamicPathReferences = new Set<string>();
  const adapter = manifest.definition.adapter;

  for (const command of [...adapter.setup, ...adapter.reset]) {
    collectCommand(command, suiteFiles, lookupPrograms, dynamicStdinFiles, dynamicPathReferences);
  }
  collectEnvironmentPatch(manifest.definition.environment, suiteFiles, dynamicPathReferences);
  for (const caseSpec of manifest.definition.cases) {
    for (const command of caseSpec.setup) {
      collectCommand(command, suiteFiles, lookupPrograms, dynamicStdinFiles, dynamicPathReferences);
    }
    collectProgram(adapter.run.program, suiteFiles, lookupPrograms);
    collectValues(adapter.run.argv, suiteFiles, dynamicPathReferences);
    collectEnvironmentPatch(adapter.run.env, suiteFiles, dynamicPathReferences);
    collectRunPatch(caseSpec.run, suiteFiles, dynamicStdinFiles, dynamicPathReferences);
    collectWorkingDirectory(caseSpec.run.cwd ?? adapter.run.cwd, dynamicPathReferences);
    collectStdin(caseSpec.run.stdin ?? adapter.run.stdin, suiteFiles, dynamicStdinFiles);
    collectOracle(caseSpec.oracle ?? adapter.oracle, dynamicPathReferences);
  }

  return {
    dynamicPathReferences,
    dynamicStdinFiles,
    lookupPrograms,
    suiteFiles,
  };
}

function collectCommand(
  command: CommandSpec,
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  lookupPrograms: Set<string>,
  dynamicStdinFiles: Set<string>,
  dynamicPathReferences: Set<string>,
): void {
  collectProgram(command.program, suiteFiles, lookupPrograms);
  collectValues(command.argv, suiteFiles, dynamicPathReferences);
  collectEnvironmentPatch(command.env, suiteFiles, dynamicPathReferences);
  collectWorkingDirectory(command.cwd, dynamicPathReferences);
  collectStdin(command.stdin, suiteFiles, dynamicStdinFiles);
}

function collectRunPatch(
  patch: RunPatch,
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  dynamicStdinFiles: Set<string>,
  dynamicPathReferences: Set<string>,
): void {
  collectValues(patch.argv, suiteFiles, dynamicPathReferences);
  collectEnvironmentPatch(patch.env, suiteFiles, dynamicPathReferences);
  if (patch.stdin !== undefined) {
    collectStdin(patch.stdin, suiteFiles, dynamicStdinFiles);
  }
}

function collectEnvironmentPatch(
  patch: EnvironmentPatch,
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  dynamicPathReferences: Set<string>,
): void {
  collectValues(Object.values(patch.set), suiteFiles, dynamicPathReferences);
}

function collectValues(
  values: readonly ValueSpec[],
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  dynamicPathReferences: Set<string>,
): void {
  for (const value of values) {
    if (typeof value === 'string') {
      continue;
    }
    const reference = value.path;
    if (reference.base === 'suite') {
      addSuiteFile(suiteFiles, reference.path, 'value');
    } else {
      dynamicPathReferences.add(
        `value\0${reference.base}\0${reference.root ?? ''}\0${reference.path}`,
      );
    }
  }
}

function collectWorkingDirectory(
  cwd: WorkingDirectorySpec,
  dynamicPathReferences: Set<string>,
): void {
  dynamicPathReferences.add(`cwd\0${cwd.base}\0${cwd.root ?? ''}\0${cwd.path}`);
}

function collectOracle(oracle: OracleSpec, dynamicPathReferences: Set<string>): void {
  switch (oracle.kind) {
    case 'fileJsonPointerEquals':
      dynamicPathReferences.add(`oracle\0${oracle.path}`);
      return;
    case 'all':
    case 'any':
      for (const rule of oracle.rules) {
        collectOracle(rule, dynamicPathReferences);
      }
      return;
    case 'not':
      collectOracle(oracle.rule, dynamicPathReferences);
      return;
    case 'exitCodeEquals':
    case 'stdoutJsonPointerEquals':
      return;
  }
}

function collectProgram(
  program: ProgramSpec,
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  lookupPrograms: Set<string>,
): void {
  if ('path' in program) {
    addSuiteFile(suiteFiles, program.path, 'program');
    return;
  }
  lookupPrograms.add(program.lookup);
}

function collectStdin(
  stdin: StdinSpec,
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  dynamicStdinFiles: Set<string>,
): void {
  if (stdin.kind !== 'file') {
    return;
  }
  const reference = stdin.path.path;
  if (reference.base === 'suite') {
    addSuiteFile(suiteFiles, reference.path, 'stdin');
    return;
  }
  dynamicStdinFiles.add(`${reference.base}\0${reference.root ?? ''}\0${reference.path}`);
}

function addSuiteFile(
  suiteFiles: Map<PortablePath, Set<DependencyRole>>,
  path: PortablePath,
  role: DependencyRole,
): void {
  const roles = suiteFiles.get(path) ?? new Set<DependencyRole>();
  roles.add(role);
  suiteFiles.set(path, roles);
}

async function inspectSuiteFile(
  suiteDir: string,
  absolutePath: string,
): Promise<InspectedDependencyFile> {
  let before: BigIntStats;
  let canonical: string;
  try {
    before = await lstat(absolutePath, { bigint: true });
    canonical = await realpath(absolutePath);
  } catch (error) {
    throw new EvidenceError('Unable to inspect a direct suite execution dependency.', {
      cause: error,
    });
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !(await isLinkFreePath(absolutePath, canonical)) ||
    !isWithin(suiteDir, canonical)
  ) {
    throw new EvidenceError(
      'A direct suite execution dependency must be a regular non-link file inside the suite.',
    );
  }
  return {
    absolutePath,
    before,
    canonicalPath: canonical,
  };
}

async function digestStableSuiteFile(
  inspected: InspectedDependencyFile,
): Promise<DependencyFileDigest> {
  const { absolutePath, before, canonicalPath } = inspected;
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalPath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      throw new EvidenceError(
        'A direct suite execution dependency changed before it could be hashed.',
      );
    }

    const content = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesReadTotal = 0n;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      content.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += BigInt(bytesRead);
      if (bytesReadTotal > before.size) {
        throw new EvidenceError('A direct suite execution dependency grew while it was hashed.');
      }
    }

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolutePath, { bigint: true });
    if (
      bytesReadTotal !== before.size ||
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(before, pathAfter)
    ) {
      throw new EvidenceError('A direct suite execution dependency changed while it was hashed.');
    }
    return {
      contentSha256: content.digest('hex'),
      executable: (before.mode & 0o111n) !== 0n,
      size: before.size,
    };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    throw new EvidenceError('Unable to hash a direct suite execution dependency.', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateLimits(limits: Readonly<ExecutionDependencyLimits>): ExecutionDependencyLimits {
  const maxFileBytes = limits.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 0 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < 0
  ) {
    throw new EvidenceError('Execution dependency byte limits must be non-negative safe integers.');
  }
  if (maxFileBytes > maxTotalBytes) {
    throw new EvidenceError(
      'Execution dependency file limit must not exceed the total byte limit.',
    );
  }
  return { maxFileBytes, maxTotalBytes };
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

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function updateText(digest: Hash, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  updateBigInteger(digest, BigInt(bytes.length));
  digest.update(bytes);
}

function updateInteger(digest: Hash, value: number): void {
  updateBigInteger(digest, BigInt(value));
}

function updateBigInteger(digest: Hash, value: bigint): void {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(value);
  digest.update(encoded);
}
