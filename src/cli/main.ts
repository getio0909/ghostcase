#!/usr/bin/env node

import { basename } from 'node:path';

import { replayEvidence, runSuite } from '../application/index.js';
import { GhostCaseError, errorMessage } from '../domain/errors.js';
import { storeEvidence } from '../evidence/index.js';
import { formatReport } from '../report/index.js';
import { version } from '../version.js';
import { parseArguments, type CommandArguments } from './arguments.js';
import { renderHelp } from './help.js';
import { formatSuiteCommand, runSuiteCommand } from './suite-commands.js';
import { writeOutput } from './write-output.js';

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.kind === 'help') {
      await writeOutput('-', renderHelp());
      return;
    }
    if (parsed.kind === 'version') {
      await writeOutput('-', `ghostcase ${version}\n`);
      return;
    }

    process.exitCode = await executeCommand(parsed, controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

async function executeCommand(arguments_: CommandArguments, signal: AbortSignal): Promise<number> {
  switch (arguments_.command) {
    case 'validate':
    case 'inspect':
    case 'doctor': {
      const result = await runSuiteCommand(arguments_.command, arguments_.suite);
      await writeOutput(arguments_.output, formatSuiteCommand(result, arguments_.format));
      if (arguments_.verbose) {
        writeVerbose(
          `${arguments_.command} completed for suite ${result.data.suite.id}; prepared ${String(
            result.data.prepared.entries,
          )} entries`,
        );
      }
      return result.exitCode;
    }
    case 'run': {
      const result = await runSuite({
        signal,
        suitePath: arguments_.suite,
        ...(arguments_.victims.length === 0 ? {} : { victimIds: arguments_.victims }),
      });
      const stored = await storeEvidence({
        evidenceDir: arguments_.evidenceDir,
        manifest: result.manifest,
        prepared: result.prepared,
        report: result.report,
      });
      await writeOutput(arguments_.output, formatReport(result.report, arguments_.format));
      if (arguments_.verbose) {
        writeVerbose(`evidence stored as ${basename(stored.path)}`);
        for (const victim of result.diagnosis.victims) {
          writeVerbose(
            `${victim.victimId}: ${victim.verdict}; prefix=${victim.prefix.kind}; minimality=${victim.minimality}; chain=${victim.minimalChainIds.join(',') || 'empty'}`,
          );
        }
      }
      return result.report.exitCode;
    }
    case 'replay': {
      const result = await replayEvidence(arguments_.evidence, { signal });
      await writeOutput(arguments_.output, formatReport(result.report, arguments_.format));
      if (arguments_.verbose) {
        writeVerbose(
          result.matched
            ? 'recorded bounded witness reproduced'
            : 'recorded bounded witness did not reproduce',
        );
      }
      return result.report.exitCode === 3 ? 3 : result.matched ? 0 : 1;
    }
  }
}

function writeVerbose(message: string): void {
  process.stderr.write(`ghostcase: ${sanitizeDiagnostic(message)}\n`);
}

function sanitizeDiagnostic(value: string): string {
  let safe = value;
  const sensitiveName = /(?:auth|cookie|credential|key|password|secret|token)/iu;
  const sensitiveValues = Object.entries(process.env)
    .filter(
      ([name, candidate]) =>
        sensitiveName.test(name) && typeof candidate === 'string' && candidate.length >= 4,
    )
    .map(([, candidate]) => candidate)
    .filter((candidate): candidate is string => candidate !== undefined)
    .sort((left, right) => right.length - left.length);
  for (const sensitive of sensitiveValues) {
    safe = safe.split(sensitive).join('[REDACTED]');
  }
  safe = safe.replace(/\b(?:sk-|ghp_|github_pat_|npm_)[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');

  let printable = '';
  for (const character of safe) {
    const codePoint = character.codePointAt(0);
    printable +=
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159))
        ? ' '
        : character;
  }
  return printable.trim().slice(0, 2048);
}

void main().catch((error: unknown) => {
  const exitCode = error instanceof GhostCaseError ? error.exitCode : 3;
  const message = sanitizeDiagnostic(errorMessage(error));
  process.stderr.write(`ghostcase: ${message.length === 0 ? 'Unknown failure.' : message}\n`);
  process.exitCode = exitCode;
});
