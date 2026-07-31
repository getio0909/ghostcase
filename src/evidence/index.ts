export {
  GHOSTCASE_EVIDENCE_SCHEMA,
  GHOSTCASE_EXECUTION_DEPENDENCIES_SCHEMA,
  EvidenceValidationError,
  createEvidence,
  validateEvidence,
  validateEvidenceLocator,
} from './model.js';
export { EVIDENCE_FILE_MAX_BYTES, loadEvidence, storeEvidence } from './store.js';

export type {
  EvidenceExecutionDependencies,
  EvidenceSuiteLocator,
  GhostCaseEvidence,
  GhostCaseEvidenceInput,
} from './model.js';
export type { LoadedEvidence, StoreEvidenceOptions, StoredEvidence } from './store.js';
