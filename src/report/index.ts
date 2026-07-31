import { formatHumanReport } from './human.js';
import { formatJsonReport } from './json.js';
import { formatJunitReport } from './junit.js';
import type { GhostCaseReport } from './model.js';
import { formatSarifReport } from './sarif.js';

export type ReportFormat = 'human' | 'json' | 'junit' | 'sarif';

export function formatReport(report: GhostCaseReport, format: ReportFormat): string {
  switch (format) {
    case 'human':
      return formatHumanReport(report);
    case 'json':
      return formatJsonReport(report);
    case 'junit':
      return formatJunitReport(report);
    case 'sarif':
      return formatSarifReport(report);
  }
}

export { formatHumanReport } from './human.js';
export { formatJsonReport } from './json.js';
export { formatJunitReport } from './junit.js';
export {
  GHOSTCASE_REPORT_SCHEMA,
  ReportValidationError,
  createReport,
  summarizeArm,
  validateReport,
} from './model.js';
export { formatSarifReport } from './sarif.js';

export type {
  GhostCaseReport,
  GhostCaseReportInput,
  GhostCaseVictimReport,
  GhostCaseVictimReportInput,
  IncompleteReportArmSummary,
  ReportArmSummary,
  ReportExitCode,
  ReportMinimality,
  ReportStateChange,
  ReportStateChangeInput,
  ReportStateChangeKind,
  ReportStatus,
  ReportVerdict,
  StableReportArmSummary,
} from './model.js';
