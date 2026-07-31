import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OracleSpecError,
  evaluateOracle,
  type OracleObservation,
  type OracleSpec,
} from '../../src/oracle/index.js';

const exitedProcess: OracleObservation['process'] = {
  status: 'exited',
  exitCode: 0,
  stdout: {
    content: '{"result":{"ok":true,"count":2}}',
    truncated: false,
  },
};

describe('evaluateOracle', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ghostcase-oracle-'));
  });

  afterEach(async () => {
    if (workspaceRoot !== '') {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  function observation(process: OracleObservation['process'] = exitedProcess): OracleObservation {
    return { process, workspaceRoot };
  }

  it('evaluates an exit-code assertion with stable, content-safe evidence', async () => {
    const spec = { kind: 'exitCodeEquals', value: 0 } as const;

    const first = await evaluateOracle(spec, observation());
    const second = await evaluateOracle(spec, observation());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'pass',
      assertions: [
        {
          id: 'oracle',
          kind: 'exitCodeEquals',
          outcome: 'pass',
          expected: 'exit code 0',
          actual: 'exit code 0',
        },
      ],
    });
    expect(first.semanticSignature).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(workspaceRoot);
  });

  it('reports a normal assertion mismatch as fail', async () => {
    const result = await evaluateOracle({ kind: 'exitCodeEquals', value: 7 }, observation());

    expect(result).toMatchObject({
      kind: 'fail',
      assertions: [{ id: 'oracle', outcome: 'fail' }],
    });
  });

  it.each(['timed_out', 'output_limit', 'aborted', 'spawn_error'] as const)(
    'classifies process status %s as invalid harness evidence',
    async (status) => {
      const result = await evaluateOracle(
        { kind: 'exitCodeEquals', value: 0 },
        observation({
          status,
          exitCode: null,
          stdout: { content: '', truncated: false },
        }),
      );

      expect(result).toMatchObject({
        kind: 'invalid',
        assertions: [
          {
            id: 'oracle',
            outcome: 'invalid',
            actual: `harness status ${status}`,
          },
        ],
      });
    },
  );

  it('classifies a missing exit code after exit as invalid', async () => {
    const result = await evaluateOracle(
      { kind: 'exitCodeEquals', value: 0 },
      observation({ ...exitedProcess, exitCode: null }),
    );

    expect(result).toMatchObject({
      kind: 'invalid',
      assertions: [{ actual: 'exit code unavailable' }],
    });
  });

  it('evaluates a JSON Pointer against captured stdout', async () => {
    const result = await evaluateOracle(
      {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/result/count',
        equals: 2,
      },
      observation(),
    );

    expect(result).toMatchObject({
      kind: 'pass',
      assertions: [
        {
          id: 'oracle',
          kind: 'stdoutJsonPointerEquals',
          outcome: 'pass',
          expected: 'number:2',
          actual: 'number:2',
        },
      ],
    });
  });

  it('does not expose compared string contents in summaries', async () => {
    const secretLikeValue = 'not-for-reporting';
    const result = await evaluateOracle(
      {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/value',
        equals: secretLikeValue,
      },
      observation({
        ...exitedProcess,
        stdout: {
          content: JSON.stringify({ value: secretLikeValue }),
          truncated: false,
        },
      }),
    );

    expect(result.kind).toBe('pass');
    expect(JSON.stringify(result)).not.toContain(secretLikeValue);
    expect(result.assertions[0]?.actual).toMatch(/^string\(length=17,sha256=[a-f0-9]{64}\)$/u);
  });

  it('fails when stdout is malformed strict JSON or the pointer is missing', async () => {
    const malformed = await evaluateOracle(
      {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/value',
        equals: 1,
      },
      observation({
        ...exitedProcess,
        stdout: { content: '{"value":1,"value":2}', truncated: false },
      }),
    );
    const missing = await evaluateOracle(
      {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/missing',
        equals: 1,
      },
      observation(),
    );

    expect(malformed).toMatchObject({
      kind: 'fail',
      assertions: [{ actual: 'stdout is not strict JSON' }],
    });
    expect(missing).toMatchObject({
      kind: 'fail',
      assertions: [{ actual: 'JSON Pointer did not resolve' }],
    });
  });

  it('classifies truncated stdout as invalid instead of a failed assertion', async () => {
    const result = await evaluateOracle(
      {
        kind: 'stdoutJsonPointerEquals',
        pointer: '/value',
        equals: 1,
      },
      observation({
        ...exitedProcess,
        stdout: { content: '{"value":1}', truncated: true },
      }),
    );

    expect(result).toMatchObject({
      kind: 'invalid',
      assertions: [{ actual: 'stdout capture was truncated' }],
    });
  });

  it('evaluates strict UTF-8 JSON from a regular workspace file', async () => {
    await mkdir(join(workspaceRoot, 'outputs'));
    await writeFile(
      join(workspaceRoot, 'outputs', 'result.json'),
      '{"result":{"ok":true}}',
      'utf8',
    );

    const result = await evaluateOracle(
      {
        kind: 'fileJsonPointerEquals',
        path: 'outputs/result.json',
        pointer: '/result/ok',
        equals: true,
      },
      observation(),
    );

    expect(result).toMatchObject({
      kind: 'pass',
      assertions: [
        {
          id: 'oracle',
          kind: 'fileJsonPointerEquals',
          outcome: 'pass',
          expected: 'boolean:true',
          actual: 'boolean:true',
        },
      ],
    });
  });

  it('treats a missing expected file as an assertion failure', async () => {
    const result = await evaluateOracle(
      {
        kind: 'fileJsonPointerEquals',
        path: 'outputs/missing.json',
        pointer: '/value',
        equals: 1,
      },
      observation(),
    );

    expect(result).toMatchObject({
      kind: 'fail',
      assertions: [{ actual: 'file does not exist' }],
    });
    expect(JSON.stringify(result)).not.toContain(workspaceRoot);
  });

  it.each([
    [Buffer.from([0xff, 0xfe]), 'file is not valid UTF-8 JSON'],
    [Buffer.from('{"value":1,"value":2}', 'utf8'), 'file is not strict JSON'],
  ])('fails safely for invalid file JSON bytes', async (bytes, actual) => {
    await writeFile(join(workspaceRoot, 'result.json'), bytes);

    const result = await evaluateOracle(
      {
        kind: 'fileJsonPointerEquals',
        path: 'result.json',
        pointer: '/value',
        equals: 1,
      },
      observation(),
    );

    expect(result).toMatchObject({
      kind: 'fail',
      assertions: [{ actual }],
    });
  });

  it('rejects a symbolic-link path component without reading through it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ghostcase-oracle-outside-'));
    try {
      await writeFile(join(outside, 'result.json'), '{"value":1}', 'utf8');
      await symlink(outside, join(workspaceRoot, 'linked'), 'junction');

      const result = await evaluateOracle(
        {
          kind: 'fileJsonPointerEquals',
          path: 'linked/result.json',
          pointer: '/value',
          equals: 1,
        },
        observation(),
      );

      expect(result).toMatchObject({
        kind: 'invalid',
        assertions: [{ actual: 'file path contains a symbolic link' }],
      });
      expect(JSON.stringify(result)).not.toContain(outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('uses deterministic three-valued logic and still evaluates every child', async () => {
    const unavailableExit: OracleObservation['process'] = {
      ...exitedProcess,
      exitCode: null,
    };
    const decisiveAny = await evaluateOracle(
      {
        kind: 'any',
        rules: [
          {
            kind: 'stdoutJsonPointerEquals',
            pointer: '/result/ok',
            equals: true,
          },
          { kind: 'exitCodeEquals', value: 0 },
        ],
      },
      observation(unavailableExit),
    );
    const undecidableAll = await evaluateOracle(
      {
        kind: 'all',
        rules: [
          {
            kind: 'stdoutJsonPointerEquals',
            pointer: '/result/ok',
            equals: true,
          },
          { kind: 'exitCodeEquals', value: 0 },
        ],
      },
      observation(unavailableExit),
    );

    expect(decisiveAny.kind).toBe('pass');
    expect(decisiveAny.assertions.map(({ id, outcome }) => [id, outcome])).toEqual([
      ['oracle', 'pass'],
      ['oracle.0', 'pass'],
      ['oracle.1', 'invalid'],
    ]);
    expect(undecidableAll.kind).toBe('invalid');
    expect(undecidableAll.assertions).toHaveLength(3);
  });

  it('lets decisive outcomes dominate invalid children in either composite', async () => {
    const unavailableExit: OracleObservation['process'] = {
      ...exitedProcess,
      exitCode: null,
    };
    const decisiveAll = await evaluateOracle(
      {
        kind: 'all',
        rules: [
          {
            kind: 'stdoutJsonPointerEquals',
            pointer: '/result/ok',
            equals: false,
          },
          { kind: 'exitCodeEquals', value: 0 },
        ],
      },
      observation(unavailableExit),
    );
    const undecidableAny = await evaluateOracle(
      {
        kind: 'any',
        rules: [
          {
            kind: 'stdoutJsonPointerEquals',
            pointer: '/result/ok',
            equals: false,
          },
          { kind: 'exitCodeEquals', value: 0 },
        ],
      },
      observation(unavailableExit),
    );

    expect(decisiveAll.kind).toBe('fail');
    expect(decisiveAll.assertions).toHaveLength(3);
    expect(undecidableAny.kind).toBe('invalid');
    expect(undecidableAny.assertions).toHaveLength(3);
  });

  it('supports nested not and all assertions with stable structural IDs', async () => {
    const spec: OracleSpec = {
      kind: 'all',
      rules: [
        { kind: 'exitCodeEquals', value: 0 },
        {
          kind: 'not',
          rule: {
            kind: 'stdoutJsonPointerEquals',
            pointer: '/result/count',
            equals: 99,
          },
        },
      ],
    };

    const result = await evaluateOracle(spec, observation());

    expect(result.kind).toBe('pass');
    expect(result.assertions.map(({ id, outcome }) => [id, outcome])).toEqual([
      ['oracle', 'pass'],
      ['oracle.0', 'pass'],
      ['oracle.1', 'pass'],
      ['oracle.1.0', 'fail'],
    ]);
  });

  it('changes the semantic signature when a semantic outcome changes', async () => {
    const passing = await evaluateOracle({ kind: 'exitCodeEquals', value: 0 }, observation());
    const failing = await evaluateOracle({ kind: 'exitCodeEquals', value: 1 }, observation());

    expect(failing.semanticSignature).not.toBe(passing.semanticSignature);
  });

  it.each([
    {
      name: 'absolute file path',
      spec: {
        kind: 'fileJsonPointerEquals',
        path: 'C:/outside.json',
        pointer: '',
        equals: null,
      },
      message: /normalized relative POSIX path/,
    },
    {
      name: 'parent traversal',
      spec: {
        kind: 'fileJsonPointerEquals',
        path: '../outside.json',
        pointer: '',
        equals: null,
      },
      message: /normalized relative POSIX path/,
    },
    {
      name: 'Windows alternate data stream',
      spec: {
        kind: 'fileJsonPointerEquals',
        path: 'result.json:stream',
        pointer: '',
        equals: null,
      },
      message: /normalized relative POSIX path/,
    },
    {
      name: 'Windows device path',
      spec: {
        kind: 'fileJsonPointerEquals',
        path: 'NUL.json',
        pointer: '',
        equals: null,
      },
      message: /normalized relative POSIX path/,
    },
    {
      name: 'invalid pointer',
      spec: {
        kind: 'stdoutJsonPointerEquals',
        pointer: 'relative',
        equals: null,
      },
      message: /JSON Pointer/,
    },
    {
      name: 'extra property',
      spec: { kind: 'exitCodeEquals', value: 0, extra: true },
      message: /exactly the properties/,
    },
    {
      name: 'non-serializable expected value',
      spec: {
        kind: 'stdoutJsonPointerEquals',
        pointer: '',
        equals: undefined,
      },
      message: /JSON-serializable/,
    },
  ])('rejects an invalid OracleSpec: $name', async ({ spec, message }) => {
    await expect(evaluateOracle(spec as unknown as OracleSpec, observation())).rejects.toThrow(
      OracleSpecError,
    );
    await expect(evaluateOracle(spec as unknown as OracleSpec, observation())).rejects.toThrow(
      message,
    );
  });
});
