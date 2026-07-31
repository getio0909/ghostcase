import { describe, expect, it } from 'vitest';

import { ParseError, parseArguments } from '../../src/cli/arguments.js';

describe('parseArguments', () => {
  it.each([
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['-V'], { kind: 'version' }],
  ])('parses the independent top-level action %j', (argv, expected) => {
    expect(parseArguments(argv)).toEqual(expected);
  });

  it.each(['validate', 'inspect', 'doctor'] as const)(
    'parses %s with command defaults',
    (command) => {
      expect(parseArguments([command])).toEqual({
        kind: 'command',
        command,
        suite: 'ghostcase.json',
        format: 'human',
        output: '-',
        verbose: false,
      });
    },
  );

  it('parses run with command defaults', () => {
    expect(parseArguments(['run'])).toEqual({
      kind: 'command',
      command: 'run',
      suite: 'ghostcase.json',
      format: 'human',
      output: '-',
      verbose: false,
      victims: [],
      evidenceDir: '.ghostcase/evidence',
    });
  });

  it('parses replay with command defaults', () => {
    expect(parseArguments(['replay', 'finding.json'])).toEqual({
      kind: 'command',
      command: 'replay',
      evidence: 'finding.json',
      format: 'human',
      output: '-',
      verbose: false,
    });
  });

  it('parses all run options and preserves repeated victim order', () => {
    expect(
      parseArguments([
        'run',
        '--victim',
        'victim-b',
        'suite.json',
        '--format',
        'sarif',
        '--victim',
        'victim-a',
        '--output',
        'report.sarif',
        '--evidence-dir',
        'artifacts/evidence',
        '-v',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'run',
      suite: 'suite.json',
      format: 'sarif',
      output: 'report.sarif',
      verbose: true,
      victims: ['victim-b', 'victim-a'],
      evidenceDir: 'artifacts/evidence',
    });
  });

  it('allows an explicit stdout output target', () => {
    expect(parseArguments(['inspect', '--format', 'json', '--output', '-'])).toEqual({
      kind: 'command',
      command: 'inspect',
      suite: 'ghostcase.json',
      format: 'json',
      output: '-',
      verbose: false,
    });
  });

  it('accepts the long verbose alias', () => {
    expect(parseArguments(['replay', '--verbose', 'finding.json'])).toMatchObject({
      kind: 'command',
      command: 'replay',
      verbose: true,
    });
  });

  it.each([
    [[], 'Expected a command'],
    [['unknown'], 'Unknown command "unknown"'],
    [['--help', 'run'], '"--help" must be used by itself'],
    [['run', '--help'], 'Unknown option "--help" for "run"'],
    [['run', '-vv'], 'Unknown option "-vv" for "run"'],
    [['run', '--format=json'], 'Unknown option "--format=json" for "run"'],
    [['run', 'one.json', 'two.json'], 'accepts at most one suite path'],
    [['replay'], 'requires an evidence path'],
    [['replay', 'one.json', 'two.json'], 'accepts exactly one evidence path'],
    [['run', ''], 'Argument 2 must not be empty'],
  ] satisfies readonly (readonly [readonly string[], string])[])(
    'rejects invalid argv %j',
    (argv, message) => {
      expectParseError(argv, message);
    },
  );

  it.each([
    ['--format', ['run', '--format']],
    ['--format', ['run', '--format', '--output', 'report.json']],
    ['--output', ['run', '--output']],
    ['--evidence-dir', ['run', '--evidence-dir']],
    ['--victim', ['run', '--victim']],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    'reports a missing value for %s',
    (option, argv) => {
      expect(() => parseArguments(argv)).toThrow(
        new ParseError(`Option "${option}" requires a value.`),
      );
    },
  );

  it.each([
    [['run', '--format', 'json', '--format', 'human'], '--format'],
    [['run', '--output', 'one.json', '--output', 'two.json'], '--output'],
    [['run', '--evidence-dir', 'one', '--evidence-dir', 'two'], '--evidence-dir'],
    [['run', '-v', '--verbose'], '--verbose'],
  ] satisfies readonly (readonly [readonly string[], string])[])(
    'rejects repeated single-value options in %j',
    (argv, option) => {
      expect(() => parseArguments(argv)).toThrow(
        new ParseError(`Option "${option}" may only be specified once.`),
      );
    },
  );

  it.each([
    [['validate', '--format', 'junit'], 'validate', 'junit', 'human, json'],
    [['inspect', '--format', 'sarif'], 'inspect', 'sarif', 'human, json'],
    [['doctor', '--format', 'xml'], 'doctor', 'xml', 'human, json'],
    [['run', '--format', 'yaml'], 'run', 'yaml', 'human, json, junit, sarif'],
    [['replay', 'finding.json', '--format', 'text'], 'replay', 'text', 'human, json, junit, sarif'],
  ] satisfies readonly (readonly [readonly string[], string, string, string])[])(
    'rejects an unsupported format for %s',
    (argv, command, format, expected) => {
      expect(() => parseArguments(argv)).toThrow(
        new ParseError(
          `Format "${format}" is not supported by "${command}"; expected one of: ${expected}.`,
        ),
      );
    },
  );

  it.each([
    [['validate', '--victim', 'case-a'], '--victim', 'validate'],
    [['inspect', '--evidence-dir', 'artifacts'], '--evidence-dir', 'inspect'],
    [['doctor', '--victim', 'case-a'], '--victim', 'doctor'],
    [['replay', 'finding.json', '--victim', 'case-a'], '--victim', 'replay'],
    [['replay', 'finding.json', '--evidence-dir', 'artifacts'], '--evidence-dir', 'replay'],
  ] satisfies readonly (readonly [readonly string[], string, string])[])(
    'rejects command-specific option %s on %s',
    (argv, option, command) => {
      expect(() => parseArguments(argv)).toThrow(
        new ParseError(`Option "${option}" is not valid for "${command}".`),
      );
    },
  );
});

function expectParseError(argv: readonly string[], message: string): void {
  let thrown: unknown;
  try {
    parseArguments(argv);
  } catch (error: unknown) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ParseError);
  if (thrown instanceof ParseError) {
    expect(thrown.message).toContain(message);
    expect(thrown.exitCode).toBe(2);
  }
}
