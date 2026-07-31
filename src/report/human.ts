import type {
  GhostCaseReport,
  GhostCaseVictimReport,
  ReportArmSummary,
  ReportStateChange,
} from './model.js';

const DIGEST_PREVIEW_LENGTH = 12;

export function formatHumanReport(report: GhostCaseReport): string {
  const lines = [
    `GhostCase ${report.toolVersion} · ${report.suite.id} · ${report.status.toUpperCase()}`,
    `source ${previewDigest(report.suite.sourceSha256)} · experiments ${String(report.experiments.used)}/${String(report.experiments.limit)} · exit ${String(report.exitCode)}`,
  ];

  for (const victim of report.victims) {
    lines.push(...formatVictim(victim));
  }
  return `${lines.join('\n')}\n`;
}

function formatVictim(victim: GhostCaseVictimReport): readonly string[] {
  const lines = [
    '',
    `${victim.id}: ${victim.verdict}`,
    `  fresh ${formatArm(victim.fresh)} · shared ${formatArm(victim.shared)}`,
    `  chain ${formatChain(victim)} · minimality ${victim.minimality}`,
    `  state ${formatStateChanges(victim.stateChanges)}`,
  ];
  if (victim.reason !== undefined) {
    lines.push(`  reason ${victim.reason}`);
  }
  return lines;
}

function formatArm(arm: ReportArmSummary): string {
  return arm.kind === 'stable'
    ? `stable/${arm.oracleOutcome} sig=${previewDigest(arm.signatureSha256)}`
    : arm.kind;
}

function formatChain(victim: GhostCaseVictimReport): string {
  return victim.minimalChain.length === 0 ? '—' : victim.minimalChain.join(' → ');
}

function formatStateChanges(changes: readonly ReportStateChange[]): string {
  if (changes.length === 0) {
    return 'none';
  }
  return changes
    .map((change) => {
      const attributes = [
        change.size === undefined ? undefined : `size=${String(change.size)}`,
        change.digest === undefined ? undefined : `digest=${previewDigest(change.digest)}`,
        `subject=${previewDigest(change.subjectId)}`,
      ].filter((attribute): attribute is string => attribute !== undefined);
      return `${change.alias}/${change.kind}(${attributes.join(',')})`;
    })
    .join(', ');
}

function previewDigest(digest: string): string {
  return digest.slice(0, DIGEST_PREVIEW_LENGTH);
}
