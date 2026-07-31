# Contributing to GhostCase

GhostCase is an MIT-licensed, security-conscious experiment harness. Contributions should preserve
determinism, explicit bounds, safe diagnostics, and the distinction between reproducible evidence
and a causal claim.

## Prerequisites

- Node.js `>=22.13.0`
- pnpm `11.5.0`
- Git

Install from a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The repository's active integration branch is `main`. Base changes on the current `main` and
target `main` with pull requests. Keep a change focused; unrelated refactors belong in a separate
change.

## Test-driven workflow

Behavior changes start with a failing test:

1. Add the smallest synthetic fixture that exposes the missing behavior.
2. Run that test and confirm it fails for the intended reason.
3. Implement the complete behavior, including error handling and bounds.
4. Run the focused test again.
5. Run formatting, lint, type checking, the full suite, and package smoke tests.
6. Review the diff for path leaks, credential leaks, nondeterminism, unsafe I/O, and accidental
   scope growth.

Useful commands:

```sh
pnpm exec vitest run test/path/to/focused.test.ts
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm package:smoke
```

The final local gate is:

```sh
pnpm check
pnpm package:smoke
```

CI runs formatting, lint, type checking, tests, and package smoke tests on Node.js 22 and 24,
Windows and Ubuntu.

## Test fixtures

Use synthetic data only:

- no real API keys, tokens, cookies, customer data, private prompts, or production endpoints;
- no fixture that depends on a network service, home-directory state, wall-clock timing, or test
  execution order unless that behavior is the explicit subject of the test;
- use temporary directories and clean them in `afterEach`/`finally`;
- make platform-specific assertions explicit and test both supported platform paths where
  practical; and
- assert that serialized reports do not contain temporary absolute paths, stdout/stderr content,
  or sentinel secrets.

Tests that create symlinks or junctions must handle only the platform's documented permission
failure. Do not turn an unexpected filesystem error into a skipped or passing test.

## Code requirements

- No `TODO`, placeholder, pseudocode, omitted branch, disabled assertion, or permanently skipped
  test.
- No shell invocation for suite commands; preserve explicit argv execution.
- Validate untrusted objects without invoking getters or retaining mutable references.
- Bound externally controlled bytes, entries, depth, attempts, and time.
- Fail closed on unstable files, ambiguous executable resolution, unsupported file types, and
  incomplete cleanup.
- Keep errors actionable internally and path/credential-safe in reports.
- Preserve canonical ordering and domain-separated hashes.
- Add production dependencies only when their value outweighs the supply-chain and portability
  cost.

Public schema changes require:

- model and strict-parser changes;
- positive, negative, boundary, and round-trip tests;
- updates to `docs/suite-format.md`, CLI help when applicable, and examples;
- a deliberate schema-version compatibility decision; and
- package smoke coverage through the installed `ghostcase` binary.

## Documentation

Documentation must describe behavior that exists on `main`. Do not add aspirational commands,
unpublished installation instructions, fake output, benchmark numbers, download counts, or
novelty claims that cannot be defended with primary sources.

When adding a security guarantee, add a test for its exact boundary and document known
limitations in `SECURITY.md`.

## Commits and pull requests

Use an imperative, scoped commit subject. A pull request should state:

- the user-visible behavior changed;
- why the previous behavior was insufficient;
- focused and full validation commands actually run;
- Windows/Linux differences;
- security or privacy impact; and
- remaining limitations.

Do not include generated secrets, local evidence, `.ghostcase/`, build output, or temporary
fixtures in a commit. Report vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not a public issue.
