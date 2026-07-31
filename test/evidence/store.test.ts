import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, type CanonicalJsonValue } from '../../src/canonical/index.js';
import { loadManifest } from '../../src/config/index.js';
import { EvidenceError } from '../../src/domain/errors.js';
import {
  GHOSTCASE_EVIDENCE_SCHEMA,
  loadEvidence,
  storeEvidence,
} from '../../src/evidence/index.js';
import {
  writeExclusiveOrConfirm,
  type EvidenceFileIdentity,
  type EvidenceWriteOperations,
} from '../../src/evidence/store.js';
import { createReport, GHOSTCASE_REPORT_SCHEMA } from '../../src/report/index.js';
import { prepareSuite, type PreparedSuite } from '../../src/workspace/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('evidence storage', () => {
  it('writes canonical content-addressed evidence and is byte-idempotent', async () => {
    const fixture = await evidenceFixture();
    const first = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });
    const second = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });
    const bytes = await readFile(first.path);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    const canonicalEvidenceDir = await realpath(fixture.evidenceDir);

    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(expectedDigest);
    expect(first.path).toBe(
      join(canonicalEvidenceDir, `evidence-suite-${expectedDigest.slice(0, 12)}.json`),
    );
    expect(bytes.toString('utf8')).toBe(
      canonicalJson(first.evidence as unknown as CanonicalJsonValue),
    );
    expect(first.evidence.suite.locator).toBe('../suite/ghostcase.json');
    expect(first.evidence.suite.preparedSeedSha256).toBe(fixture.prepared.snapshot.digest);
    expect(first.evidence.suite.executionDependencies).toMatchObject({
      boundSuiteFiles: 2,
      unboundDynamicPathReferences: 1,
      unboundDynamicStdinFiles: 0,
      unboundLookupPrograms: 1,
      unboundSuitePathReferences: 0,
    });

    const serialized = bytes.toString('utf8');
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toMatch(/stdout|stderr|environment|sourcePath|suiteDir/iu);
  });

  it('fails closed when an existing content-addressed name has different bytes', async () => {
    const fixture = await evidenceFixture();
    const stored = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });
    await writeFile(stored.path, '{"collision":true}', 'utf8');

    await expect(
      storeEvidence({
        evidenceDir: fixture.evidenceDir,
        manifest: fixture.manifest,
        prepared: fixture.prepared,
        report: fixture.report,
      }),
    ).rejects.toBeInstanceOf(EvidenceError);
  });

  it('rejects and safely cleans an exclusive write whose close fails', async () => {
    const identity = Object.freeze({ dev: 7n, ino: 11n });
    let cleanupIdentity: EvidenceFileIdentity | undefined;
    const operations: EvidenceWriteOperations = {
      openExclusive: () =>
        Promise.resolve({
          close: () => Promise.reject(new Error('injected close failure')),
          identity: () => Promise.resolve(identity),
          sync: () => Promise.resolve(),
          writeFile: () => Promise.resolve(),
        }),
      readVerified: () =>
        Promise.resolve({
          bytes: Buffer.from('unexpected', 'utf8'),
          identity,
        }),
      removeIfSame: (_sourcePath, expectedIdentity) => {
        cleanupIdentity = expectedIdentity;
        return Promise.resolve();
      },
    };

    await expect(
      writeExclusiveOrConfirm('injected-evidence.json', Buffer.from('{}', 'utf8'), operations),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EvidenceError && error.message.includes('sync, close, and verification'),
    );
    expect(cleanupIdentity).toEqual(identity);
  });

  it('loads strict evidence, resolves the locator, and revalidates the manifest digest', async () => {
    const fixture = await evidenceFixture();
    const stored = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });

    const loaded = await loadEvidence(stored.path);

    expect(loaded.evidence).toEqual(stored.evidence);
    expect(loaded.manifest.sourcePath).toBe(fixture.manifest.sourcePath);
    expect(loaded.sourcePath).toBe(stored.path);
  });

  it('rejects duplicate keys, unknown fields, invalid locators, and malformed reports', async () => {
    const fixture = await evidenceFixture();
    const stored = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });
    const raw = JSON.parse(await readFile(stored.path, 'utf8')) as Record<string, unknown>;

    const duplicatePath = join(fixture.evidenceDir, 'duplicate.json');
    await writeFile(
      duplicatePath,
      `{"schema":"${GHOSTCASE_EVIDENCE_SCHEMA}","schema":"${GHOSTCASE_EVIDENCE_SCHEMA}"}`,
      'utf8',
    );
    await expect(loadEvidence(duplicatePath)).rejects.toBeInstanceOf(EvidenceError);

    const unknownPath = join(fixture.evidenceDir, 'unknown.json');
    await writeFile(unknownPath, JSON.stringify({ ...raw, stdout: 'private' }), 'utf8');
    await expect(loadEvidence(unknownPath)).rejects.toBeInstanceOf(EvidenceError);

    const locatorPath = join(fixture.evidenceDir, 'locator.json');
    await writeFile(
      locatorPath,
      JSON.stringify({
        ...raw,
        suite: {
          ...(raw.suite as object),
          locator: fixture.manifest.sourcePath,
        },
      }),
      'utf8',
    );
    await expect(loadEvidence(locatorPath)).rejects.toBeInstanceOf(EvidenceError);

    const reportPath = join(fixture.evidenceDir, 'report.json');
    await writeFile(
      reportPath,
      JSON.stringify({
        ...raw,
        report: { ...(raw.report as object), status: 'findings' },
      }),
      'utf8',
    );
    await expect(loadEvidence(reportPath)).rejects.toBeInstanceOf(EvidenceError);
  });

  it('rejects stale manifests, links, oversized files, and non-files', async () => {
    const fixture = await evidenceFixture();
    const stored = await storeEvidence({
      evidenceDir: fixture.evidenceDir,
      manifest: fixture.manifest,
      prepared: fixture.prepared,
      report: fixture.report,
    });

    await writeFile(fixture.manifest.sourcePath, `${fixture.manifestSource}\n`, 'utf8');
    await expect(loadEvidence(stored.path)).rejects.toThrow(/stale|digest|source/iu);

    const oversizedPath = join(fixture.evidenceDir, 'oversized.json');
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x20);
    await writeFile(oversizedPath, oversized);
    await expect(loadEvidence(oversizedPath)).rejects.toBeInstanceOf(EvidenceError);

    await expect(loadEvidence(fixture.evidenceDir)).rejects.toBeInstanceOf(EvidenceError);

    const linkPath = join(fixture.evidenceDir, 'evidence-link.json');
    try {
      await symlink(stored.path, linkPath, 'file');
      await expect(loadEvidence(linkPath)).rejects.toBeInstanceOf(EvidenceError);
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      )) {
        throw error;
      }
    }
  });

  it('rejects a symlink evidence directory when the platform permits creating one', async () => {
    const fixture = await evidenceFixture();
    const target = join(fixture.root, 'actual-evidence');
    const link = join(fixture.root, 'linked-evidence');
    await rm(fixture.evidenceDir, { force: true, recursive: true });
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(
        storeEvidence({
          evidenceDir: link,
          manifest: fixture.manifest,
          prepared: fixture.prepared,
          report: fixture.report,
        }),
      ).rejects.toBeInstanceOf(EvidenceError);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      )) {
        throw error;
      }
    }
  });

  it('rejects evidence when the prepared seed no longer matches the manifest inputs', async () => {
    const fixture = await evidenceFixture();
    await writeFile(fixture.seedFilePath, 'changed seed', 'utf8');

    await expect(
      storeEvidence({
        evidenceDir: fixture.evidenceDir,
        manifest: fixture.manifest,
        prepared: fixture.prepared,
        report: fixture.report,
      }),
    ).rejects.toThrow(/prepared seed|seed digest/iu);
  });

  it('rejects loading evidence after a seed or direct suite dependency changes', async () => {
    const seedFixture = await evidenceFixture();
    const seedEvidence = await storeEvidence({
      evidenceDir: seedFixture.evidenceDir,
      manifest: seedFixture.manifest,
      prepared: seedFixture.prepared,
      report: seedFixture.report,
    });
    await writeFile(seedFixture.seedFilePath, 'changed seed', 'utf8');

    await expect(loadEvidence(seedEvidence.path)).rejects.toThrow(/seed digest/iu);

    const dependencyFixture = await evidenceFixture();
    const dependencyEvidence = await storeEvidence({
      evidenceDir: dependencyFixture.evidenceDir,
      manifest: dependencyFixture.manifest,
      prepared: dependencyFixture.prepared,
      report: dependencyFixture.report,
    });
    await writeFile(dependencyFixture.stdinPath, '{"changed":true}', 'utf8');

    await expect(loadEvidence(dependencyEvidence.path)).rejects.toThrow(/execution dependenc/iu);
  });
});

interface EvidenceFixture {
  readonly evidenceDir: string;
  readonly manifest: Awaited<ReturnType<typeof loadManifest>>;
  readonly manifestSource: string;
  readonly prepared: PreparedSuite;
  readonly report: ReturnType<typeof createReport>;
  readonly root: string;
  readonly seedFilePath: string;
  readonly stdinPath: string;
}

async function evidenceFixture(): Promise<EvidenceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ghostcase-evidence-'));
  temporaryDirectories.push(root);
  const suiteDir = join(root, 'suite');
  const evidenceDir = join(root, 'evidence');
  const seedDir = join(suiteDir, 'seed');
  await mkdir(suiteDir);
  await mkdir(seedDir);
  const manifestPath = join(suiteDir, 'ghostcase.json');
  const directProgramPath = join(suiteDir, 'direct-program.bin');
  const seedFilePath = join(seedDir, 'memory.json');
  const stdinPath = join(suiteDir, 'input.json');
  await Promise.all([
    writeFile(directProgramPath, 'direct program bytes', 'utf8'),
    writeFile(seedFilePath, '{"seed":true}', 'utf8'),
    writeFile(stdinPath, '{"input":true}', 'utf8'),
  ]);
  const manifestSource = JSON.stringify({
    adapter: {
      setup: [
        {
          program: { path: 'direct-program.bin' },
        },
      ],
      run: {
        argv: ['-e', 'process.exit(0)'],
        program: { lookup: 'node' },
        stdin: {
          kind: 'file',
          path: { path: { base: 'suite', path: 'input.json' } },
        },
      },
      snapshot: { roots: [{ root: 'workspace' }] },
    },
    cases: [
      { id: 'control', run: { argv: [] } },
      { id: 'victim', run: { argv: [] } },
    ],
    schema: 'ghostcase/suite/v1',
    stateRoots: [{ id: 'workspace', seed: { kind: 'copy', path: 'seed' } }],
    suite: { id: 'evidence-suite', repetitions: 2 },
  });
  await writeFile(manifestPath, manifestSource, 'utf8');
  const manifest = await loadManifest(manifestPath);
  const prepared = await prepareSuite(manifest);
  const report = createReport({
    exitCode: 0,
    experiments: { limit: 4, used: 4 },
    schema: GHOSTCASE_REPORT_SCHEMA,
    status: 'clean',
    suite: {
      id: manifest.definition.suite.id,
      sourceSha256: manifest.sourceSha256,
    },
    toolVersion: '0.1.0',
    victims: [
      {
        fresh: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'b'.repeat(64),
        },
        id: 'victim',
        minimalChain: [],
        minimality: 'not_applicable',
        shared: {
          kind: 'stable',
          oracleOutcome: 'pass',
          signatureSha256: 'b'.repeat(64),
        },
        stateChanges: [],
        verdict: 'CLEAN',
      },
    ],
  });
  return {
    evidenceDir,
    manifest,
    manifestSource,
    prepared,
    report,
    root,
    seedFilePath,
    stdinPath,
  };
}
