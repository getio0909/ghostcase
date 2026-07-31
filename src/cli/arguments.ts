import { UsageError } from '../domain/errors.js';

export const COMMAND_NAMES = ['validate', 'inspect', 'doctor', 'run', 'replay'] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
export type OutputFormat = 'human' | 'json' | 'junit' | 'sarif';

type SuiteCommandName = Exclude<CommandName, 'run' | 'replay'>;
type SuiteOutputFormat = Extract<OutputFormat, 'human' | 'json'>;

export interface HelpArguments {
  readonly kind: 'help';
}

export interface VersionArguments {
  readonly kind: 'version';
}

interface SharedCommandArguments {
  readonly kind: 'command';
  readonly output: string;
  readonly verbose: boolean;
}

export interface SuiteCommandArguments extends SharedCommandArguments {
  readonly command: SuiteCommandName;
  readonly format: SuiteOutputFormat;
  readonly suite: string;
}

export interface RunArguments extends SharedCommandArguments {
  readonly command: 'run';
  readonly evidenceDir: string;
  readonly format: OutputFormat;
  readonly suite: string;
  readonly victims: readonly string[];
}

export interface ReplayArguments extends SharedCommandArguments {
  readonly command: 'replay';
  readonly evidence: string;
  readonly format: OutputFormat;
}

export type CommandArguments = SuiteCommandArguments | RunArguments | ReplayArguments;
export type ParsedArguments = HelpArguments | VersionArguments | CommandArguments;

const DEFAULT_SUITE = 'ghostcase.json';
const DEFAULT_EVIDENCE_DIR = '.ghostcase/evidence';
const DEFAULT_OUTPUT = '-';
const SUITE_FORMATS = ['human', 'json'] as const;
const REPORT_FORMATS = ['human', 'json', 'junit', 'sarif'] as const;
const TOP_LEVEL_ACTIONS = new Map<string, HelpArguments | VersionArguments>([
  ['--help', { kind: 'help' }],
  ['-h', { kind: 'help' }],
  ['--version', { kind: 'version' }],
  ['-V', { kind: 'version' }],
]);

type SingleOption = 'format' | 'output' | 'evidenceDir' | 'verbose';

interface CollectedOptions {
  readonly evidenceDir: string;
  readonly format: string;
  readonly output: string;
  readonly positionals: readonly string[];
  readonly verbose: boolean;
  readonly victims: readonly string[];
}

export class ParseError extends UsageError {
  public constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0) {
    throw new ParseError('Expected a command. Run ghostcase --help for usage.');
  }

  assertNoEmptyArguments(argv);

  const first = argv[0];
  if (first === undefined) {
    throw new ParseError('Expected a command. Run ghostcase --help for usage.');
  }

  const topLevelAction = TOP_LEVEL_ACTIONS.get(first);
  if (topLevelAction !== undefined) {
    if (argv.length !== 1) {
      throw new ParseError(`"${first}" must be used by itself.`);
    }
    return topLevelAction;
  }

  if (!isCommandName(first)) {
    throw new ParseError(`Unknown command "${first}".`);
  }

  const options = collectOptions(first, argv.slice(1));
  return buildCommandArguments(first, options);
}

function assertNoEmptyArguments(argv: readonly string[]): void {
  const emptyIndex = argv.findIndex((argument) => argument.length === 0);
  if (emptyIndex !== -1) {
    throw new ParseError(`Argument ${String(emptyIndex + 1)} must not be empty.`);
  }
}

function isCommandName(value: string): value is CommandName {
  return COMMAND_NAMES.some((command) => command === value);
}

function collectOptions(command: CommandName, argv: readonly string[]): CollectedOptions {
  let evidenceDir = DEFAULT_EVIDENCE_DIR;
  let format = 'human';
  let output = DEFAULT_OUTPUT;
  let verbose = false;
  const positionals: string[] = [];
  const victims: string[] = [];
  const seen = new Set<SingleOption>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    switch (argument) {
      case '--format': {
        markSeenOnce(seen, 'format', argument);
        format = readOptionValue(argv, index, argument);
        index += 1;
        break;
      }
      case '--output': {
        markSeenOnce(seen, 'output', argument);
        output = readOptionValue(argv, index, argument, true);
        index += 1;
        break;
      }
      case '--evidence-dir': {
        assertRunOnlyOption(command, argument);
        markSeenOnce(seen, 'evidenceDir', argument);
        evidenceDir = readOptionValue(argv, index, argument);
        index += 1;
        break;
      }
      case '--victim': {
        assertRunOnlyOption(command, argument);
        victims.push(readOptionValue(argv, index, argument));
        index += 1;
        break;
      }
      case '-v':
      case '--verbose': {
        markSeenOnce(seen, 'verbose', argument);
        verbose = true;
        break;
      }
      default: {
        if (argument.startsWith('-')) {
          throw new ParseError(`Unknown option "${argument}" for "${command}".`);
        }
        positionals.push(argument);
      }
    }
  }

  return {
    evidenceDir,
    format,
    output,
    positionals,
    verbose,
    victims,
  };
}

function markSeenOnce(seen: Set<SingleOption>, option: SingleOption, spelling: string): void {
  if (seen.has(option)) {
    throw new ParseError(`Option "${spelling}" may only be specified once.`);
  }
  seen.add(option);
}

function readOptionValue(
  argv: readonly string[],
  optionIndex: number,
  option: string,
  allowDash = false,
): string {
  const value = argv[optionIndex + 1];
  const isOptionLike = value?.startsWith('-') === true && !(allowDash && value === '-');
  if (value === undefined || value.length === 0 || isOptionLike) {
    throw new ParseError(`Option "${option}" requires a value.`);
  }
  return value;
}

function assertRunOnlyOption(command: CommandName, option: string): void {
  if (command !== 'run') {
    throw new ParseError(`Option "${option}" is not valid for "${command}".`);
  }
}

function buildCommandArguments(command: CommandName, options: CollectedOptions): CommandArguments {
  if (command === 'replay') {
    return buildReplayArguments(options);
  }

  const suite = readSuitePath(command, options.positionals);
  if (command === 'run') {
    return {
      kind: 'command',
      command,
      suite,
      format: readReportFormat(command, options.format),
      output: options.output,
      verbose: options.verbose,
      victims: options.victims,
      evidenceDir: options.evidenceDir,
    };
  }

  return {
    kind: 'command',
    command,
    suite,
    format: readSuiteFormat(command, options.format),
    output: options.output,
    verbose: options.verbose,
  };
}

function buildReplayArguments(options: CollectedOptions): ReplayArguments {
  if (options.positionals.length === 0) {
    throw new ParseError('Command "replay" requires an evidence path.');
  }
  if (options.positionals.length !== 1) {
    throw new ParseError('Command "replay" accepts exactly one evidence path.');
  }

  const evidence = options.positionals[0];
  if (evidence === undefined) {
    throw new ParseError('Command "replay" requires an evidence path.');
  }

  return {
    kind: 'command',
    command: 'replay',
    evidence,
    format: readReportFormat('replay', options.format),
    output: options.output,
    verbose: options.verbose,
  };
}

function readSuitePath(
  command: Exclude<CommandName, 'replay'>,
  positionals: readonly string[],
): string {
  if (positionals.length > 1) {
    throw new ParseError(`Command "${command}" accepts at most one suite path.`);
  }
  return positionals[0] ?? DEFAULT_SUITE;
}

function readSuiteFormat(command: SuiteCommandName, format: string): SuiteOutputFormat {
  if (isOneOf(format, SUITE_FORMATS)) {
    return format;
  }
  throw unsupportedFormat(command, format, SUITE_FORMATS);
}

function readReportFormat(command: 'run' | 'replay', format: string): OutputFormat {
  if (isOneOf(format, REPORT_FORMATS)) {
    return format;
  }
  throw unsupportedFormat(command, format, REPORT_FORMATS);
}

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return values.some((candidate) => candidate === value);
}

function unsupportedFormat(
  command: CommandName,
  format: string,
  expected: readonly string[],
): ParseError {
  return new ParseError(
    `Format "${format}" is not supported by "${command}"; expected one of: ${expected.join(', ')}.`,
  );
}
