export { diffFilesystemSnapshots } from './diff.js';
export { captureFilesystemSnapshot } from './filesystem.js';

export type {
  CompleteFilesystemDiff,
  FilesystemChange,
  FilesystemChangeKind,
  FilesystemDiffCounts,
  FilesystemDiffFailure,
  FilesystemDiffResult,
  IncompatibleFilesystemSnapshotReason,
} from './diff.js';
export type {
  CaptureFilesystemSnapshotOptions,
  FilesystemDirectoryEntry,
  FilesystemFileEntry,
  FilesystemIoError,
  FilesystemLimitExceededError,
  FilesystemLimitName,
  FilesystemObserverRoot,
  FilesystemOperation,
  FilesystemSnapshot,
  FilesystemSnapshotCounts,
  FilesystemSnapshotEntry,
  FilesystemSnapshotError,
  FilesystemSnapshotFailure,
  FilesystemSnapshotLimits,
  FilesystemSnapshotResult,
  InvalidFilesystemConfigError,
  InvalidFilesystemConfigReason,
  UnstableFilesystemStateError,
  UnsafeFilesystemPathError,
  UnsafeFilesystemPathReason,
  UnsupportedFilesystemTypeError,
} from './filesystem.js';
