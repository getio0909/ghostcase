#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageName = 'ghostcase';
const binaryName = 'ghostcase';
const exampleRelativePath = 'examples/memory-leak/ghostcase.json';
const commandTimeoutMs = 120_000;
const childOutputLimit = 4 * 1024 * 1024;
const temporaryDirectories = [];

async function main() {
  try {
    const packDirectory = await temporaryDirectory('ghostcase-pack-');
    const installDirectory = await temporaryDirectory('ghostcase-install-');
    const evidenceDirectory = path.join(installDirectory, 'evidence');

    const tarball = await packProject(packDirectory);
    await initializeInstall(installDirectory);
    installTarball(installDirectory, tarball);

    const installedPackage = path.join(installDirectory, 'node_modules', packageName);
    const manifest = JSON.parse(
      await readFile(path.join(installedPackage, 'package.json'), 'utf8'),
    );
    assertInstalledManifest(manifest);
    await assertInstalledBoundary(installedPackage);
    await assertCommandShim(installDirectory);

    const entrypoint = path.join(installedPackage, 'dist', 'cli', 'main.js');
    const example = path.join(installedPackage, ...exampleRelativePath.split('/'));
    const environment = isolatedEnvironment();

    const help = runCli(entrypoint, ['--help'], installDirectory, environment);
    assert(help.stdout.includes('GhostCase finds deterministic cross-case state pollution'));
    assert(help.stdout.endsWith('\n'));

    const version = runCli(entrypoint, ['--version'], installDirectory, environment);
    assert(version.stdout === `${binaryName} ${manifest.version}\n`);

    const validation = jsonOutput(
      runCli(entrypoint, ['validate', example, '--format', 'json'], installDirectory, environment)
        .stdout,
    );
    assert(validation.data?.command === 'validate');
    assert(validation.data?.suite?.id === 'memory-leak-demo');

    const inspection = jsonOutput(
      runCli(entrypoint, ['inspect', example, '--format', 'json'], installDirectory, environment)
        .stdout,
    );
    assert(inspection.data?.command === 'inspect');
    assert(inspection.data?.search?.repetitions === 2);

    const doctor = jsonOutput(
      runCli(entrypoint, ['doctor', example, '--format', 'json'], installDirectory, environment)
        .stdout,
    );
    assert(doctor.data?.command === 'doctor');
    assert(doctor.data?.checks?.snapshot === 'ok');

    const run = jsonOutput(
      runCli(
        entrypoint,
        [
          'run',
          example,
          '--victim',
          'victim',
          '--format',
          'json',
          '--evidence-dir',
          evidenceDirectory,
        ],
        installDirectory,
        environment,
        [1],
      ).stdout,
    );
    assert(run.status === 'findings');
    assert(run.victims?.[0]?.verdict === 'POLLUTION');
    assert(JSON.stringify(run.victims?.[0]?.minimalChain) === '["polluter"]');

    const evidenceFiles = await readdir(evidenceDirectory);
    assert(evidenceFiles.length === 1 && evidenceFiles[0]?.endsWith('.json'));
    const replay = jsonOutput(
      runCli(
        entrypoint,
        ['replay', path.join(evidenceDirectory, evidenceFiles[0]), '--format', 'json'],
        installDirectory,
        environment,
      ).stdout,
    );
    assert(replay.victims?.[0]?.verdict === 'POLLUTION');

    process.stdout.write('GhostCase package smoke passed (7/7 installed CLI checks).\n');
  } finally {
    await cleanup();
  }
}

function packProject(packDirectory) {
  const result = runChild(
    npmExecutable,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    projectRoot,
    isolatedEnvironment(),
  );
  const output = jsonOutput(result.stdout);
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error('npm pack did not return exactly one package record.');
  }
  const record = output[0];
  if (!isRecord(record) || typeof record.filename !== 'string' || !Array.isArray(record.files)) {
    throw new Error('npm pack returned a malformed package record.');
  }
  const files = record.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string') {
      throw new Error('npm pack returned a malformed file entry.');
    }
    return file.path;
  });
  assertPackageFiles(files);
  return resolveTarball(packDirectory, record.filename);
}

async function resolveTarball(packDirectory, filename) {
  if (filename.length === 0 || path.basename(filename) !== filename || !filename.endsWith('.tgz')) {
    throw new Error('npm pack returned an unsafe tarball filename.');
  }
  const resolvedPackDirectory = await realpath(packDirectory);
  const tarball = path.resolve(resolvedPackDirectory, filename);
  if (path.dirname(tarball) !== resolvedPackDirectory) {
    throw new Error('npm pack placed the tarball outside its destination.');
  }
  return tarball;
}

function initializeInstall(directory) {
  const manifest = {
    name: 'ghostcase-smoke-install',
    private: true,
    version: '1.0.0',
  };
  return writeFile(path.join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
}

function installTarball(directory, tarball) {
  runChild(
    npmExecutable,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', tarball],
    directory,
    isolatedEnvironment(),
  );
}

function assertInstalledManifest(manifest) {
  if (
    !isRecord(manifest) ||
    manifest.name !== packageName ||
    typeof manifest.version !== 'string' ||
    !isRecord(manifest.bin) ||
    manifest.bin[binaryName] !== './dist/cli/main.js'
  ) {
    throw new Error('The installed package manifest has an invalid CLI contract.');
  }
}

async function assertInstalledBoundary(packageDirectory) {
  for (const required of [
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'docs/suite-format.md',
    'dist/cli/main.js',
    exampleRelativePath,
  ]) {
    await access(path.join(packageDirectory, ...required.split('/')), fsConstants.R_OK);
  }
  for (const forbidden of ['src', 'test', 'scripts', '.github']) {
    try {
      await access(path.join(packageDirectory, forbidden), fsConstants.F_OK);
      throw new Error(`The installed package unexpectedly contains '${forbidden}/'.`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
}

async function assertCommandShim(installDirectory) {
  const shim = path.join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
  );
  await access(shim, fsConstants.X_OK);
}

function assertPackageFiles(files) {
  const normalized = [...new Set(files)].sort();
  for (const required of [
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'docs/suite-format.md',
    'dist/cli/main.js',
    exampleRelativePath,
    'package.json',
  ]) {
    assert(normalized.includes(required));
  }
  for (const file of normalized) {
    const [root] = file.split('/');
    assert(!['.github', 'scripts', 'src', 'test', 'node_modules'].includes(root));
    assert(!/(?:^|\/)\.env(?:\.|$)/iu.test(file));
  }
}

function runCli(entrypoint, arguments_, cwd, environment, acceptedExitCodes = [0]) {
  return runChild(
    process.execPath,
    [entrypoint, ...arguments_],
    cwd,
    environment,
    acceptedExitCodes,
  );
}

function runChild(command, arguments_, cwd, environment, acceptedExitCodes = [0]) {
  const invocation = childInvocation(command, arguments_);
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd,
    encoding: 'utf8',
    env: environment,
    maxBuffer: childOutputLimit,
    timeout: commandTimeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`Child command could not run (${safeCode(result.error)}).`, {
      cause: result.error,
    });
  }
  if (result.status === null || !acceptedExitCodes.includes(result.status)) {
    throw new Error(
      `Child command exited unexpectedly: status=${String(result.status)}, signal=${String(
        result.signal,
      )}, stdout=${sanitize(result.stdout)}, stderr=${sanitize(result.stderr)}`,
    );
  }
  if (result.stderr !== '') {
    throw new Error(`Child command wrote stderr: ${sanitize(result.stderr)}`);
  }
  return {
    stdout: result.stdout,
  };
}

function childInvocation(command, arguments_) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, arguments: arguments_ };
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    arguments: ['/d', '/s', '/c', command, ...arguments_],
  };
}

function isolatedEnvironment() {
  const environment = {
    ...process.env,
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'GOOGLE_API_KEY',
  ]) {
    delete environment[name];
  }
  return environment;
}

async function temporaryDirectory(prefix) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(root, prefix));
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('Temporary directory escaped its expected root.');
  }
  temporaryDirectories.push({ directory: resolved, prefix, root });
  return resolved;
}

async function cleanup() {
  const failures = [];
  for (const temporary of temporaryDirectories.splice(0).reverse()) {
    try {
      if (
        path.dirname(temporary.directory) !== temporary.root ||
        !path.basename(temporary.directory).startsWith(temporary.prefix)
      ) {
        throw new Error('Refusing to clean an unexpected directory.');
      }
      await rm(temporary.directory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Package smoke cleanup failed.');
  }
}

function jsonOutput(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error('Child output was not valid JSON.', { cause: error });
  }
}

function assert(condition) {
  if (!condition) {
    throw new Error('An installed package assertion failed.');
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function sanitize(value) {
  const redacted = String(value).replace(
    /\b(?:sk|ghp|github_pat|npm)_[A-Za-z0-9_-]{8,}\b/gu,
    '[REDACTED]',
  );
  let printable = '';
  for (const character of redacted) {
    const codePoint = character.codePointAt(0);
    printable +=
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
        ? '?'
        : character;
  }
  return printable.slice(0, 2048);
}

main().catch((error) => {
  process.stderr.write(
    `GhostCase package smoke failed: ${sanitize(
      error instanceof Error ? error.message : 'Unknown failure.',
    )}\n`,
  );
  process.exitCode = 1;
});
