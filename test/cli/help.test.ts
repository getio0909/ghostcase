import { describe, expect, it } from 'vitest';

import { HELP_TEXT, renderHelp } from '../../src/cli/help.js';

describe('renderHelp', () => {
  it('returns the exported help text with exactly one trailing newline', () => {
    expect(renderHelp()).toBe(HELP_TEXT);
    expect(HELP_TEXT.endsWith('\n')).toBe(true);
    expect(HELP_TEXT.endsWith('\n\n')).toBe(false);
  });

  it.each([
    'ghostcase validate [suite] [options]',
    'ghostcase inspect [suite] [options]',
    'ghostcase doctor [suite] [options]',
    'ghostcase run [suite] [options]',
    'ghostcase replay <evidence.json> [options]',
  ])('documents the command usage %s', (usage) => {
    expect(HELP_TEXT).toContain(usage);
  });

  it('documents top-level actions as standalone invocations', () => {
    expect(HELP_TEXT).toContain('ghostcase --help');
    expect(HELP_TEXT).toContain('ghostcase --version');
    expect(HELP_TEXT).toContain('Top-level actions must be used by themselves.');
  });

  it('documents defaults and the output format matrix', () => {
    expect(HELP_TEXT).toContain('Default suite: ghostcase.json');
    expect(HELP_TEXT).toContain('validate, inspect, doctor: human | json');
    expect(HELP_TEXT).toContain('run, replay: human | json | junit | sarif');
    expect(HELP_TEXT).toContain('Default: human');
    expect(HELP_TEXT).toContain('Default: .ghostcase/evidence');
  });

  it.each([
    '--victim <case-id>',
    '--format <format>',
    '--output <path|->',
    '--evidence-dir <path>',
    '-v, --verbose',
  ])('documents option %s', (option) => {
    expect(HELP_TEXT).toContain(option);
  });

  it('states the execution and report safety boundaries', () => {
    expect(HELP_TEXT).toContain('argv array without a shell');
    expect(HELP_TEXT).toContain('isolated clone of the immutable seed');
    expect(HELP_TEXT).toContain('JSON evidence');
  });
});
