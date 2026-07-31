import { canonicalJson, type CanonicalJsonValue } from '../canonical/index.js';
import type {
  GhostCaseReport,
  GhostCaseVictimReport,
  ReportStateChange,
  ReportVerdict,
} from './model.js';

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json';

interface RuleDefinition {
  readonly defaultLevel: 'error' | 'warning';
  readonly description: string;
  readonly resultKind: 'fail' | 'review';
}

const RULES: Readonly<Record<Exclude<ReportVerdict, 'CLEAN'>, RuleDefinition>> = Object.freeze({
  HARNESS_ERROR: {
    defaultLevel: 'error',
    description: 'GhostCase could not complete an experiment safely.',
    resultKind: 'fail',
  },
  HIDDEN_DEPENDENCY: {
    defaultLevel: 'error',
    description: 'A victim fails fresh but passes after an ordered predecessor chain.',
    resultKind: 'fail',
  },
  INCONCLUSIVE: {
    defaultLevel: 'warning',
    description: 'GhostCase could not collect enough evidence for a verdict.',
    resultKind: 'review',
  },
  NON_REPRODUCIBLE: {
    defaultLevel: 'warning',
    description: 'Repeated observations did not produce a stable classification.',
    resultKind: 'review',
  },
  OUTCOME_SHIFT: {
    defaultLevel: 'warning',
    description: 'A victim keeps its pass/fail outcome but changes its stable signature.',
    resultKind: 'fail',
  },
  POLLUTION: {
    defaultLevel: 'error',
    description: 'A victim passes fresh but fails after an ordered predecessor chain.',
    resultKind: 'fail',
  },
});

export function formatSarifReport(report: GhostCaseReport): string {
  const resultVictims = report.victims.filter(
    (
      victim,
    ): victim is GhostCaseVictimReport & {
      readonly verdict: Exclude<ReportVerdict, 'CLEAN'>;
    } => victim.verdict !== 'CLEAN',
  );
  const usedVerdicts = new Set(resultVictims.map((victim) => victim.verdict));
  const rules = Object.entries(RULES)
    .filter(([verdict]) => usedVerdicts.has(verdict as Exclude<ReportVerdict, 'CLEAN'>))
    .map(([verdict, definition]) => sarifRule(verdict, definition));

  const sarif: CanonicalJsonValue = {
    $schema: SARIF_SCHEMA,
    runs: [
      {
        invocations: [
          {
            executionSuccessful: report.status !== 'harness_error',
            exitCode: report.exitCode,
          },
        ],
        results: resultVictims.map(sarifResult),
        tool: {
          driver: {
            name: 'GhostCase',
            rules,
            semanticVersion: report.toolVersion,
          },
        },
      },
    ],
    version: '2.1.0',
  };
  return `${canonicalJson(sarif)}\n`;
}

function sarifRule(verdict: string, definition: RuleDefinition): CanonicalJsonValue {
  return {
    defaultConfiguration: {
      level: definition.defaultLevel,
    },
    fullDescription: {
      text: definition.description,
    },
    id: `GHOSTCASE_${verdict}`,
    name: verdict,
    shortDescription: {
      text: definition.description,
    },
  };
}

function sarifResult(
  victim: GhostCaseVictimReport & {
    readonly verdict: Exclude<ReportVerdict, 'CLEAN'>;
  },
): CanonicalJsonValue {
  const rule = RULES[victim.verdict];
  return {
    kind: rule.resultKind,
    level: rule.defaultLevel,
    message: {
      text: victim.reason ?? defaultMessage(victim.verdict),
    },
    properties: {
      fresh: armProperties(victim.fresh),
      minimalChain: victim.minimalChain,
      minimality: victim.minimality,
      shared: armProperties(victim.shared),
      stateChanges: victim.stateChanges.map(stateChangeProperties),
      victimId: victim.id,
    },
    ruleId: `GHOSTCASE_${victim.verdict}`,
  };
}

function armProperties(arm: GhostCaseVictimReport['fresh']): CanonicalJsonValue {
  return arm.kind === 'stable'
    ? {
        kind: arm.kind,
        oracleOutcome: arm.oracleOutcome,
        signatureSha256: arm.signatureSha256,
      }
    : { kind: arm.kind };
}

function stateChangeProperties(change: ReportStateChange): CanonicalJsonValue {
  return {
    alias: change.alias,
    ...(change.digest === undefined ? {} : { digest: change.digest }),
    kind: change.kind,
    ...(change.size === undefined ? {} : { size: change.size }),
    subjectId: change.subjectId,
  };
}

function defaultMessage(verdict: Exclude<ReportVerdict, 'CLEAN'>): string {
  return RULES[verdict].description;
}
