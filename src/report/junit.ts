import type { GhostCaseReport, GhostCaseVictimReport, ReportVerdict } from './model.js';

interface JunitCounts {
  readonly errors: number;
  readonly failures: number;
  readonly skipped: number;
  readonly tests: number;
}

export function formatJunitReport(report: GhostCaseReport): string {
  const counts = countVerdicts(report.victims);
  const attributes = formatCountAttributes(counts);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="GhostCase" ${attributes}>`,
    `  <testsuite name="${escapeXml(report.suite.id)}" ${attributes}>`,
  ];
  for (const victim of report.victims) {
    lines.push(...formatTestCase(report.suite.id, victim));
  }
  lines.push('  </testsuite>', '</testsuites>');
  return `${lines.join('\n')}\n`;
}

function formatTestCase(suiteId: string, victim: GhostCaseVictimReport): readonly string[] {
  const opening = `    <testcase classname="GhostCase.${escapeXml(suiteId)}" name="${escapeXml(victim.id)}"`;
  if (victim.verdict === 'CLEAN') {
    return [`${opening} />`];
  }

  const message = victim.reason ?? defaultMessage(victim);
  const body = describeVictim(victim);
  if (isFinding(victim.verdict)) {
    return [
      `${opening}>`,
      `      <failure type="${victim.verdict}" message="${escapeXml(message)}">${escapeXml(body)}</failure>`,
      '    </testcase>',
    ];
  }
  if (victim.verdict === 'HARNESS_ERROR') {
    return [
      `${opening}>`,
      `      <error type="HARNESS_ERROR" message="${escapeXml(message)}">${escapeXml(body)}</error>`,
      '    </testcase>',
    ];
  }
  return [
    `${opening}>`,
    `      <skipped message="${escapeXml(message)}">${escapeXml(body)}</skipped>`,
    '    </testcase>',
  ];
}

function countVerdicts(victims: readonly GhostCaseVictimReport[]): JunitCounts {
  let errors = 0;
  let failures = 0;
  let skipped = 0;
  for (const victim of victims) {
    if (isFinding(victim.verdict)) {
      failures += 1;
    } else if (victim.verdict === 'HARNESS_ERROR') {
      errors += 1;
    } else if (victim.verdict !== 'CLEAN') {
      skipped += 1;
    }
  }
  return { errors, failures, skipped, tests: victims.length };
}

function formatCountAttributes(counts: JunitCounts): string {
  return `tests="${String(counts.tests)}" failures="${String(counts.failures)}" errors="${String(counts.errors)}" skipped="${String(counts.skipped)}"`;
}

function describeVictim(victim: GhostCaseVictimReport): string {
  const chain = victim.minimalChain.length === 0 ? 'none' : victim.minimalChain.join(' -> ');
  return [
    `verdict=${victim.verdict}`,
    `minimality=${victim.minimality}`,
    `chain=${chain}`,
    `stateChanges=${String(victim.stateChanges.length)}`,
  ].join('; ');
}

function defaultMessage(victim: GhostCaseVictimReport): string {
  switch (victim.verdict) {
    case 'POLLUTION':
      return 'Victim passes fresh and fails after the reported chain.';
    case 'HIDDEN_DEPENDENCY':
      return 'Victim fails fresh and passes after the reported chain.';
    case 'OUTCOME_SHIFT':
      return 'Victim outcome signature changes after the reported chain.';
    case 'NON_REPRODUCIBLE':
      return 'Victim observations were not reproducible.';
    case 'INCONCLUSIVE':
      return 'Experiment evidence was inconclusive.';
    case 'HARNESS_ERROR':
      return 'The experiment harness failed.';
    case 'CLEAN':
      return 'No cross-case state effect was observed.';
  }
}

function isFinding(verdict: ReportVerdict): boolean {
  return verdict === 'HIDDEN_DEPENDENCY' || verdict === 'OUTCOME_SHIFT' || verdict === 'POLLUTION';
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
