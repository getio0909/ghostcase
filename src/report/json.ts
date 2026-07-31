import { canonicalJson, type CanonicalJsonValue } from '../canonical/index.js';
import type { GhostCaseReport } from './model.js';

export function formatJsonReport(report: GhostCaseReport): string {
  return `${canonicalJson(report as unknown as CanonicalJsonValue)}\n`;
}
