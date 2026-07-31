import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/domain/errors.js';
import { runSuite } from '../../src/application/run-suite.js';

const exampleSuite = resolve(import.meta.dirname, '../../examples/memory-leak/ghostcase.json');

describe('runSuite', () => {
  it('finds the minimal memory polluter and keeps control cases clean', async () => {
    const result = await runSuite({ suitePath: exampleSuite });

    expect(result.report).toMatchObject({
      exitCode: 1,
      status: 'findings',
      suite: { id: 'memory-leak-demo' },
    });
    expect(result.report.victims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'noise', verdict: 'CLEAN' }),
        expect.objectContaining({ id: 'polluter', verdict: 'CLEAN' }),
        expect.objectContaining({
          id: 'victim',
          minimalChain: ['polluter'],
          minimality: 'proven',
          verdict: 'POLLUTION',
        }),
      ]),
    );

    const victim = result.report.victims.find(({ id }) => id === 'victim');
    expect(victim?.stateChanges).toHaveLength(1);
    expect(victim?.stateChanges[0]).toMatchObject({
      alias: 'memory',
      kind: 'added',
    });
    expect(victim?.stateChanges[0]?.subjectId).toMatch(/^[a-f0-9]{64}$/u);
  }, 60_000);

  it('runs only explicitly selected victims', async () => {
    const result = await runSuite({
      suitePath: exampleSuite,
      victimIds: ['victim'],
    });

    expect(result.report.victims.map(({ id }) => id)).toEqual(['victim']);
    expect(result.diagnosis.victims.map(({ victimId }) => victimId)).toEqual(['victim']);
  }, 60_000);

  it.each([
    { victimIds: ['missing'], expected: 'unknown' },
    { victimIds: ['victim', 'victim'], expected: 'duplicate' },
    { victimIds: [], expected: 'at least one' },
  ])('rejects $expected victim selections', async ({ victimIds, expected }) => {
    await expect(runSuite({ suitePath: exampleSuite, victimIds })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConfigError && error.message.toLowerCase().includes(expected),
    );
  });

  it('turns suite cancellation into safe harness evidence', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSuite({
      signal: controller.signal,
      suitePath: exampleSuite,
      victimIds: ['victim'],
    });

    expect(result.report).toMatchObject({
      exitCode: 3,
      status: 'harness_error',
      victims: [
        {
          id: 'victim',
          reason: 'fresh_arm_harness_error',
          verdict: 'HARNESS_ERROR',
        },
      ],
    });
  });

  it('fails closed without executing cases on an unsupported host platform', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platformDescriptor === undefined) {
      throw new Error('process.platform descriptor is unavailable.');
    }
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    try {
      const result = await runSuite({
        suitePath: exampleSuite,
        victimIds: ['victim'],
      });

      expect(result.diagnosis).toMatchObject({
        experiments: { used: 0 },
        platform: 'unsupported',
      });
      expect(result.report).toMatchObject({
        exitCode: 3,
        status: 'inconclusive',
        victims: [
          {
            fresh: { kind: 'inconclusive' },
            id: 'victim',
            shared: { kind: 'inconclusive' },
            verdict: 'INCONCLUSIVE',
          },
        ],
      });
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('emits deterministic reports without absolute paths, output, secrets, or durations', async () => {
    const secret = 'synthetic-report-secret-must-not-leak';
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const options = {
        suitePath: exampleSuite,
        victimIds: ['victim'],
      } as const;
      const first = await runSuite(options);
      const second = await runSuite(options);
      const serialized = JSON.stringify(first.report);

      expect(second.report).toEqual(first.report);
      expect(serialized).not.toContain(resolve(exampleSuite));
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(/stdout|stderr|duration|environment|sourcePath|suiteDir/iu);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousSecret;
      }
    }
  }, 60_000);
});
