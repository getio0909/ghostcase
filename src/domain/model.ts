import type { OracleSpec } from '../oracle/index.js';

declare const portablePathBrand: unique symbol;

export type PortablePath = string & { readonly [portablePathBrand]: true };

export type PlatformName = 'linux' | 'win32';

export interface SuiteSearch {
  readonly maxChainLength: number;
  readonly maxExperiments: number;
}

export interface SuiteSpec {
  readonly description: string;
  readonly id: string;
  readonly repetitions: number;
  readonly search: SuiteSearch;
}

export interface EmptySeedSpec {
  readonly kind: 'empty';
}

export interface CopySeedSpec {
  readonly kind: 'copy';
  readonly path: PortablePath;
}

export type SeedSpec = CopySeedSpec | EmptySeedSpec;

export interface StateRootSpec {
  readonly id: string;
  readonly seed: SeedSpec;
}

export interface PathReference {
  readonly base: 'state' | 'suite' | 'temp';
  readonly path: PortablePath;
  readonly root?: string;
}

export interface PathValueSpec {
  readonly path: PathReference;
}

export type ValueSpec = PathValueSpec | string;

export interface EnvironmentPatch {
  readonly set: Readonly<Record<string, ValueSpec>>;
  readonly unset: readonly string[];
}

export interface EnvironmentSpec extends EnvironmentPatch {
  readonly inherit: readonly string[];
}

export type StdinSpec =
  | {
      readonly kind: 'file';
      readonly path: PathValueSpec;
    }
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'text';
      readonly value: string;
    };

export interface WorkingDirectorySpec {
  readonly base: 'state' | 'temp';
  readonly path: PortablePath;
  readonly root?: string;
}

export type ProgramSpec =
  | {
      readonly lookup: string;
    }
  | {
      readonly path: PortablePath;
    };

export interface CommandSpec {
  readonly argv: readonly ValueSpec[];
  readonly cwd: WorkingDirectorySpec;
  readonly env: EnvironmentPatch;
  readonly program: ProgramSpec;
  readonly stdin: StdinSpec;
  readonly timeoutMs: number;
}

export interface RunPatch {
  readonly argv: readonly ValueSpec[];
  readonly cwd?: WorkingDirectorySpec;
  readonly env: EnvironmentPatch;
  readonly stdin?: StdinSpec;
  readonly timeoutMs?: number;
}

export interface SnapshotRootSpec {
  readonly root: string;
}

export interface SnapshotSpec {
  readonly roots: readonly SnapshotRootSpec[];
}

export interface AdapterSpec {
  readonly oracle: OracleSpec;
  readonly reset: readonly CommandSpec[];
  readonly run: CommandSpec;
  readonly setup: readonly CommandSpec[];
  readonly snapshot: SnapshotSpec;
}

export interface CaseSpec {
  readonly description: string;
  readonly id: string;
  readonly oracle?: OracleSpec;
  readonly platforms: readonly PlatformName[];
  readonly run: RunPatch;
  readonly setup: readonly CommandSpec[];
  readonly tags: readonly string[];
}

export interface ExecutionSpec {
  readonly armTimeoutMs: number;
  readonly caseTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshotEntries: number;
  readonly maxSnapshotFileBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStdinBytes: number;
  readonly maxStdoutBytes: number;
  readonly stepTimeoutMs: number;
  readonly suiteTimeoutMs: number;
}

export interface ManifestDefinition {
  readonly adapter: AdapterSpec;
  readonly cases: readonly CaseSpec[];
  readonly environment: EnvironmentSpec;
  readonly execution: ExecutionSpec;
  readonly schema: 'ghostcase/suite/v1';
  readonly stateRoots: readonly StateRootSpec[];
  readonly suite: SuiteSpec;
}

export type ResolvedSeedSpec =
  | EmptySeedSpec
  | {
      readonly kind: 'copy';
      readonly path: PortablePath;
      readonly resolvedPath: string;
    };

export interface ResolvedStateRoot {
  readonly id: string;
  readonly seed: ResolvedSeedSpec;
}

export interface LoadedManifest {
  readonly definition: ManifestDefinition;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly stateRoots: readonly ResolvedStateRoot[];
  readonly suiteDir: string;
}
