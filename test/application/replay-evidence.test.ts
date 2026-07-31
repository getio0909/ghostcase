import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { replayEvidence } from '../../src/application/replay-evidence.js';
import { runSuite } from '../../src/application/run-suite.js';
import { loadManifest } from '../../src/config/index.js';
import { EvidenceError } from '../../src/domain/errors.js';
import type { LoadedManifest } from '../../src/domain/model.js';
import { storeEvidence } from '../../src/evidence/index.js';
import {
  createReport,
  GHOSTCASE_REPORT_SCHEMA,
  type GhostCaseReport,
} from '../../src/report/index.js';
import { version as VERSION } from '../../src/version.js';
import { prepareSuite, type PreparedSuite } from '../../src/workspace/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('replayEvidence', () => {
  it('replays only the recorded witness with fresh and shared repetitions', async () => {
    const fixture = await replayFixture({ discoverFinding: true });

    const replay = await replayEvidence(fixture.evidencePath, {
      temporaryRoot: fixture.temporaryRoot,
    });
    const invocations = (await readFile(fixture.trackerPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);

    expect(replay.matched).toBe(true);
    expect(replay.report).toMatchObject({
      exitCode: 1,
      status: 'findings',
      victims: [
        {
          id: 'victim',
          minimalChain: ['polluter'],
          verdict: 'POLLUTION',
        },
      ],
    });
    expect(invocations.filter((id) => id === 'victim')).toHaveLength(4);
    expect(invocations.filter((id) => id === 'polluter')).toHaveLength(2);
    expect(invocations).not.toContain('noise');
  }, 60_000);

  it('reports a safe mismatch when the recorded witness no longer shifts the victim', async () => {
    const fixture = await replayFixture();
    const stored = await storeEvidence({
      evidenceDir: join(fixture.root, 'mismatch-evidence'),
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: pollutionReport(fixture.report, ['noise']),
    });

    const replay = await replayEvidence(stored.path, {
      temporaryRoot: fixture.temporaryRoot,
    });

    expect(replay.matched).toBe(false);
    expect(replay.report).toMatchObject({
      exitCode: 0,
      status: 'clean',
      victims: [
        {
          id: 'victim',
          minimalChain: [],
          minimality: 'not_applicable',
          reason: 'expected_pollution_observed_clean',
          verdict: 'CLEAN',
        },
      ],
    });
  }, 60_000);

  it('does not match when deterministic filesystem state changes differ', async () => {
    const fixture = await replayFixture();
    const stored = await storeEvidence({
      evidenceDir: join(fixture.root, 'state-change-evidence'),
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: reportWithoutStateChanges(fixture.report),
    });

    const replay = await replayEvidence(stored.path, {
      temporaryRoot: fixture.temporaryRoot,
    });

    expect(replay.report.victims[0]).toMatchObject({
      minimalChain: ['polluter'],
      verdict: 'POLLUTION',
    });
    expect(replay.report.victims[0]?.stateChanges).not.toEqual(
      replay.expectedReport.victims[0]?.stateChanges,
    );
    expect(replay.matched).toBe(false);
  }, 60_000);

  it('does not match when the same state subject contains different bytes', async () => {
    const fixture = await replayFixture({ discoverFinding: true });
    const expectedChange = fixture.report.victims[0]?.stateChanges[0];
    if (
      expectedChange?.digest === undefined ||
      expectedChange.size === undefined ||
      expectedChange.kind !== 'added'
    ) {
      throw new Error('Replay fixture did not retain file content evidence.');
    }
    await writeFile(fixture.pollutionControlPath, '{"voice":"bishop"}', 'utf8');

    const replay = await replayEvidence(fixture.evidencePath, {
      temporaryRoot: fixture.temporaryRoot,
    });
    const actualChange = replay.report.victims[0]?.stateChanges[0];

    expect(replay.report.victims[0]).toMatchObject({
      minimalChain: ['polluter'],
      verdict: 'POLLUTION',
    });
    expect(replay.matched).toBe(false);
    expect(actualChange).toMatchObject({
      alias: expectedChange.alias,
      kind: expectedChange.kind,
      size: expectedChange.size,
      subjectId: expectedChange.subjectId,
    });
    expect(actualChange?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(actualChange?.digest).not.toBe(expectedChange.digest);
  }, 60_000);

  it('turns an aborted replay into harness evidence without leaking output or secrets', async () => {
    const fixture = await replayFixture();
    const controller = new AbortController();
    controller.abort();
    const secret = 'synthetic-replay-secret-must-not-leak';
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const replay = await replayEvidence(fixture.evidencePath, {
        signal: controller.signal,
        temporaryRoot: fixture.temporaryRoot,
      });
      const serialized = JSON.stringify(replay.report);

      expect(replay.matched).toBe(false);
      expect(replay.report).toMatchObject({
        exitCode: 3,
        status: 'harness_error',
        victims: [
          {
            id: 'victim',
            minimalChain: [],
            verdict: 'HARNESS_ERROR',
          },
        ],
      });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(fixture.root);
      expect(serialized).not.toMatch(/stdout|stderr|environment|sourcePath|suiteDir/iu);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousSecret;
      }
    }
  }, 60_000);

  it.each([
    { chain: ['polluter'], victimId: 'missing-victim' },
    { chain: ['missing-predecessor'], victimId: 'victim' },
  ])(
    'rejects a stale recorded case reference',
    async ({ chain, victimId }) => {
      const fixture = await replayFixture();
      const recorded = fixture.report.victims[0];
      if (recorded?.fresh.kind !== 'stable' || recorded.shared.kind !== 'stable') {
        throw new Error('Replay fixture did not produce stable evidence.');
      }
      const report = createReport({
        exitCode: 1,
        experiments: fixture.report.experiments,
        schema: GHOSTCASE_REPORT_SCHEMA,
        status: 'findings',
        suite: fixture.report.suite,
        toolVersion: fixture.report.toolVersion,
        victims: [
          {
            fresh: recorded.fresh,
            id: victimId,
            minimalChain: chain,
            minimality: 'proven',
            shared: recorded.shared,
            stateChanges: recorded.stateChanges,
            verdict: 'POLLUTION',
          },
        ],
      });
      const stored = await storeEvidence({
        evidenceDir: join(fixture.root, `invalid-${victimId}`),
        manifest: fixture.manifest,
        prepared: fixture.prepared,
        report,
      });

      await expect(replayEvidence(stored.path)).rejects.toBeInstanceOf(EvidenceError);
    },
    60_000,
  );

  it.each([
    { chain: ['later'], label: 'a predecessor after the victim' },
    { chain: ['polluter', 'noise'], label: 'a decreasing predecessor sequence' },
  ])(
    'rejects a recorded chain containing $label',
    async ({ chain }) => {
      const fixture = await replayFixture();
      const report = pollutionReport(fixture.report, chain);
      const stored = await storeEvidence({
        evidenceDir: join(fixture.root, `invalid-order-${chain.join('-')}`),
        manifest: fixture.manifest,
        prepared: fixture.prepared,
        report,
      });
      await writeFile(fixture.trackerPath, '', 'utf8');

      await expect(replayEvidence(stored.path)).rejects.toThrow(/before|increasing|order/iu);
      expect(await readFile(fixture.trackerPath, 'utf8')).toBe('');
    },
    60_000,
  );

  it.each(['victim', 'chain'] as const)(
    'does not execute and returns inconclusive when the recorded %s is not supported on this host',
    async (unsupportedRole) => {
      const unsupportedPlatform = process.platform === 'win32' ? 'linux' : 'win32';
      const fixture = await replayFixture({
        platformOverrides:
          unsupportedRole === 'victim'
            ? { victim: [unsupportedPlatform] }
            : { polluter: [unsupportedPlatform] },
      });
      await writeFile(fixture.trackerPath, '', 'utf8');

      const replay = await replayEvidence(fixture.evidencePath, {
        temporaryRoot: fixture.temporaryRoot,
      });

      expect(replay.matched).toBe(false);
      expect(replay.report).toMatchObject({
        exitCode: 3,
        status: 'inconclusive',
        victims: [
          {
            fresh: { kind: 'inconclusive' },
            id: 'victim',
            minimalChain: [],
            shared: { kind: 'inconclusive' },
            verdict: 'INCONCLUSIVE',
          },
        ],
      });
      expect(await readFile(fixture.trackerPath, 'utf8')).toBe('');
    },
    60_000,
  );

  it('does not execute and returns inconclusive on an unsupported host platform', async () => {
    const fixture = await replayFixture();
    await writeFile(fixture.trackerPath, '', 'utf8');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platformDescriptor === undefined) {
      throw new Error('process.platform descriptor is unavailable.');
    }
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    try {
      const replay = await replayEvidence(fixture.evidencePath, {
        temporaryRoot: fixture.temporaryRoot,
      });

      expect(replay.matched).toBe(false);
      expect(replay.report).toMatchObject({
        exitCode: 3,
        status: 'inconclusive',
        victims: [
          {
            id: 'victim',
            reason: 'recorded_host_platform_not_supported',
            verdict: 'INCONCLUSIVE',
          },
        ],
      });
      expect(await readFile(fixture.trackerPath, 'utf8')).toBe('');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  }, 60_000);
});

interface ReplayFixture {
  readonly agentPath: string;
  readonly evidencePath: string;
  readonly manifest: LoadedManifest;
  readonly pollutionControlPath: string;
  readonly prepared: PreparedSuite;
  readonly report: GhostCaseReport;
  readonly root: string;
  readonly temporaryRoot: string;
  readonly trackerPath: string;
}

interface ReplayFixtureOptions {
  readonly discoverFinding?: boolean;
  readonly platformOverrides?: Readonly<Record<string, readonly string[]>>;
}

async function replayFixture(options: ReplayFixtureOptions = {}): Promise<ReplayFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ghostcase-replay-'));
  temporaryDirectories.push(root);
  const suiteDir = join(root, 'suite');
  const evidenceDir = join(root, 'evidence');
  const temporaryRoot = join(root, 'arms');
  await Promise.all([mkdir(suiteDir), mkdir(temporaryRoot)]);

  const agentPath = join(suiteDir, 'agent.mjs');
  const trackerPath = join(suiteDir, 'tracker.log');
  const pollutionControlPath = `${trackerPath}.pollution`;
  const manifestPath = join(suiteDir, 'ghostcase.json');
  await writeFile(agentPath, agentSource({ victimAlwaysPasses: false }), 'utf8');
  await writeFile(
    manifestPath,
    JSON.stringify({
      adapter: {
        oracle: {
          equals: true,
          kind: 'stdoutJsonPointerEquals',
          pointer: '/ok',
        },
        run: {
          argv: [{ path: { base: 'suite', path: 'agent.mjs' } }, trackerPath],
          cwd: { base: 'state', path: '.', root: 'memory' },
          program: { lookup: 'node' },
        },
        snapshot: { roots: [{ root: 'memory' }] },
      },
      cases: [
        {
          id: 'noise',
          platforms: options.platformOverrides?.noise,
          run: { argv: ['noise'] },
        },
        {
          id: 'polluter',
          platforms: options.platformOverrides?.polluter,
          run: { argv: ['polluter'] },
        },
        {
          id: 'victim',
          platforms: options.platformOverrides?.victim,
          run: { argv: ['victim'] },
        },
        { id: 'later', run: { argv: ['later'] } },
      ],
      execution: {
        armTimeoutMs: 10_000,
        caseTimeoutMs: 5_000,
        cleanupTimeoutMs: 5_000,
        maxSnapshotBytes: 1_048_576,
        maxSnapshotEntries: 64,
        maxSnapshotFileBytes: 65_536,
        maxStderrBytes: 65_536,
        maxStdinBytes: 65_536,
        maxStdoutBytes: 65_536,
        stepTimeoutMs: 5_000,
        suiteTimeoutMs: 60_000,
      },
      schema: 'ghostcase/suite/v1',
      stateRoots: [{ id: 'memory', seed: { kind: 'empty' } }],
      suite: {
        id: 'replay-suite',
        repetitions: 2,
        search: { maxChainLength: 8, maxExperiments: 64 },
      },
    }),
    'utf8',
  );

  const initial =
    options.discoverFinding === true
      ? await runSuite({
          suitePath: manifestPath,
          temporaryRoot,
          victimIds: ['victim'],
        })
      : undefined;
  const manifest = initial?.manifest ?? (await loadManifest(manifestPath));
  const prepared = initial?.prepared ?? (await prepareSuite(manifest));
  const report = initial?.report ?? manualPollutionReport(manifest, ['polluter']);
  if (options.discoverFinding === true) {
    expect(report.victims[0]).toMatchObject({
      minimalChain: ['polluter'],
      verdict: 'POLLUTION',
    });
  }
  const stored = await storeEvidence({
    evidenceDir,
    manifest,
    prepared,
    report,
  });
  await writeFile(trackerPath, '', 'utf8');

  return {
    agentPath,
    evidencePath: stored.path,
    manifest,
    pollutionControlPath,
    prepared,
    report,
    root,
    temporaryRoot,
    trackerPath,
  };
}

function manualPollutionReport(
  manifest: LoadedManifest,
  chain: readonly string[],
): GhostCaseReport {
  return createReport({
    exitCode: 1,
    experiments: { limit: 4, used: 0 },
    schema: GHOSTCASE_REPORT_SCHEMA,
    status: 'findings',
    suite: {
      id: manifest.definition.suite.id,
      sourceSha256: manifest.sourceSha256,
    },
    toolVersion: VERSION,
    victims: [
      {
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'a'.repeat(64),
        },
        id: 'victim',
        minimalChain: chain,
        minimality: 'proven',
        shared: {
          kind: 'stable',
          oracleOutcome: 'fail',
          signatureSha256: 'b'.repeat(64),
        },
        stateChanges: [],
        verdict: 'POLLUTION',
      },
    ],
  });
}

function pollutionReport(base: GhostCaseReport, chain: readonly string[]): GhostCaseReport {
  return createReport({
    exitCode: 1,
    experiments: base.experiments,
    schema: GHOSTCASE_REPORT_SCHEMA,
    status: 'findings',
    suite: base.suite,
    toolVersion: base.toolVersion,
    victims: [
      {
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'a'.repeat(64),
        },
        id: 'victim',
        minimalChain: chain,
        minimality: 'proven',
        shared: {
          kind: 'stable',
          oracleOutcome: 'fail',
          signatureSha256: 'b'.repeat(64),
        },
        stateChanges: [],
        verdict: 'POLLUTION',
      },
    ],
  });
}

function reportWithoutStateChanges(base: GhostCaseReport): GhostCaseReport {
  const victim = base.victims[0];
  if (victim === undefined) {
    throw new Error('Replay fixture report has no victim.');
  }
  return createReport({
    ...base,
    victims: [
      {
        ...victim,
        stateChanges: [],
      },
    ],
  });
}

function agentSource(options: { readonly victimAlwaysPasses: boolean }): string {
  return [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    'const [tracker, action] = process.argv.slice(2);',
    'appendFileSync(tracker, `${action}\\n`);',
    'const pollutionControl = `${tracker}.pollution`;',
    'const pollution = existsSync(pollutionControl) ? readFileSync(pollutionControl, \'utf8\') : \'{"voice":"pirate"}\';',
    "if (action === 'polluter') writeFileSync('persona.json', pollution);",
    options.victimAlwaysPasses
      ? 'const ok = true;'
      : "const ok = action !== 'victim' || !existsSync('persona.json');",
    'process.stdout.write(JSON.stringify({ ok }));',
  ].join('\n');
}
