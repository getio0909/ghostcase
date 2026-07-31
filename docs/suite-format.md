# GhostCase suite format

This document specifies `ghostcase/suite/v1` as implemented by GhostCase `0.1.x`. A suite is one
strict JSON file plus any suite-relative programs and seed directories it references.

The runnable repository example is
[`examples/memory-leak/ghostcase.json`](../examples/memory-leak/ghostcase.json).

## Strict JSON envelope

The manifest is read as exact bytes and is limited to 256 KiB. GhostCase rejects:

- invalid UTF-8, a byte-order mark, trailing content, and duplicate decoded object keys;
- unknown fields at every schema-owned object;
- `__proto__`, `constructor`, and `prototype` keys;
- array holes or non-array properties;
- non-finite numbers, negative zero, and integer values outside JavaScript's safe range;
- NUL, lone Unicode surrogates, and values beyond their field-specific bounds; and
- a manifest path that is not a stable regular non-link file.

IDs for suites, state roots, cases, and tags match `^[a-z][a-z0-9_-]{0,63}$`. Case order is
semantic: only eligible cases before a victim can be its predecessors.

## Top-level object

| Field         | Required | Meaning                                                                |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `schema`      | yes      | Must be exactly `"ghostcase/suite/v1"`.                                |
| `suite`       | yes      | Suite identity, repetitions, and search budget.                        |
| `stateRoots`  | yes      | One to 16 persistent roots cloned into each experiment arm.            |
| `environment` | no       | Explicit host inheritance and deterministic environment patches.       |
| `execution`   | no       | Time, stream, fixture, and snapshot limits.                            |
| `adapter`     | yes      | Framework-neutral command lifecycle, default oracle, and snapshot set. |
| `cases`       | yes      | Two to 256 ordered eval cases.                                         |

No additional top-level fields are accepted.

## `suite`

```json
{
  "id": "memory-leak-demo",
  "description": "Find a persona leaked between eval cases.",
  "repetitions": 3,
  "search": {
    "maxChainLength": 8,
    "maxExperiments": 256
  }
}
```

| Field                   | Default | Bounds    | Meaning                                                   |
| ----------------------- | ------- | --------- | --------------------------------------------------------- |
| `id`                    | —       | ID syntax | Required stable suite ID.                                 |
| `description`           | `""`    | 1024 B    | Human context; it is not used by an oracle.               |
| `repetitions`           | `3`     | 2–9       | Required identical valid observations for every arm.      |
| `search.maxChainLength` | `8`     | 1–64      | Nearest eligible predecessors retained for each victim.   |
| `search.maxExperiments` | `256`   | 1–4096    | Global arm-attempt budget shared by victims and searches. |

An arm gets at most `repetitions` attempts and needs all of them to be valid. There are no hidden
retries. Different valid semantic signatures produce `NON_REPRODUCIBLE`; some valid and some
invalid attempts produce `INCONCLUSIVE`; zero valid attempts with an execution failure produce
`HARNESS_ERROR`.

## State roots and immutable seeds

Each state root has a unique ID and one seed:

```json
{
  "id": "memory",
  "seed": {
    "kind": "copy",
    "path": "fixtures/neutral-memory"
  }
}
```

`seed.kind` is:

- `"empty"`: create an empty root; no `path` is allowed.
- `"copy"`: load `path`, relative to the manifest directory, into an immutable in-memory seed
  snapshot.

Copy seeds accept regular files and directories only. Links, junctions, detected reparse points,
special files, unstable reads, duplicate case-folded paths, and paths outside the seed are
rejected. Default preparation limits are depth 64, 10,000 combined entries, 16 MiB per file, and
64 MiB combined bytes; configured snapshot limits can lower those bounds.

The prepared layout for every arm is:

```text
<arm>/
  state/
    <root-id>/
  temp/
```

Fresh and shared arms are independent materializations of the exact same prepared seed digest.
Commands never mutate the source seed directory.

## Portable paths and typed path references

A portable path uses relative POSIX syntax even on Windows. `"."` means the selected root itself.
Other paths:

- use `/`, never `\`;
- cannot be absolute, drive-qualified, empty, or contain `.`/`..` segments;
- cannot contain empty segments, control characters, `< > : " | ? *`, or NUL;
- cannot end a segment with a dot or space;
- cannot use Windows device names such as `CON`, `NUL`, `COM1`, or `LPT1`; and
- are limited to 32 segments, 255 UTF-8 bytes per segment, and 4096 bytes total.

An argv or environment value is either a literal string or a typed path:

```json
{
  "path": {
    "base": "state",
    "root": "memory",
    "path": "checkpoints/current.json"
  }
}
```

| `base`    | `root`                 | Resolution                             |
| --------- | ---------------------- | -------------------------------------- |
| `"state"` | required state-root ID | Inside that materialized state root.   |
| `"suite"` | forbidden              | Inside the manifest's directory.       |
| `"temp"`  | forbidden              | Inside the arm's disposable temp root. |

Typed paths are resolved to absolute argv/environment values only at execution time. There is no
variable expansion, shell interpolation, globbing, or command substitution.

`cwd` uses the inner reference shape directly and permits only `"state"` or `"temp"`:

```json
{
  "base": "state",
  "root": "memory",
  "path": "."
}
```

The directory must already exist, resolve without a link, and remain inside the materialized arm.

## Environment

The default command environment does not inherit the caller's environment. The suite-level
environment has three disjoint, ASCII-case-insensitive sets:

```json
{
  "inherit": ["OPENAI_API_KEY"],
  "set": {
    "AGENT_MODE": "eval",
    "MEMORY_DIR": {
      "path": {
        "base": "state",
        "root": "memory",
        "path": "."
      }
    }
  },
  "unset": ["HTTP_PROXY"]
}
```

- `inherit` explicitly copies named values from the host and fails if one is absent.
- `set` accepts literal or typed-path values.
- `unset` removes a name.

Explicit inheritance may include provider credentials such as `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`. Doing so deliberately gives that secret to every configured child command.
GhostCase never prints the value, but it cannot stop the child from reading or exfiltrating it.

To reduce loader and shell injection, `inherit` and `set` reject:

- `BASH_ENV`, `COMSPEC`, `ENV`, `LD_LIBRARY_PATH`, `LD_PRELOAD`;
- `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_V8_COVERAGE`;
- `PATHEXT`;
- any name beginning `DYLD_`; and
- any name beginning `GHOSTCASE_`.

Those names may appear in `unset`. A valid environment variable name matches
`^[A-Za-z_][A-Za-z0-9_]{0,127}$`. At most 32 names may be inherited and at most 64 total names may
be referenced by a patch.

Resolution order is:

1. explicitly inherit suite names;
2. apply suite `unset`, then suite `set`;
3. apply the merged adapter/case command patch; and
4. pin GhostCase's internal values.

GhostCase pins `GHOSTCASE=1`, `HOME`, `TMP`, and `TEMP` to the arm temp directory. On Windows it
also pins `USERPROFILE` there and supplies the host `SystemRoot`/`WINDIR` when available. The host
`PATH` is consulted to resolve a `program.lookup`; it is not otherwise inherited unless the
manifest explicitly names it.

## Execution limits

All fields are optional.

| Field                  | Default     | Minimum | Hard maximum |
| ---------------------- | ----------- | ------- | ------------ |
| `stepTimeoutMs`        | `30000`     | 100     | 600000       |
| `caseTimeoutMs`        | `60000`     | 1000    | 600000       |
| `armTimeoutMs`         | `300000`    | 1000    | 1800000      |
| `suiteTimeoutMs`       | `1800000`   | 1000    | 86400000     |
| `cleanupTimeoutMs`     | `30000`     | 1000    | 120000       |
| `maxStdoutBytes`       | `1048576`   | 0       | 33554432     |
| `maxStderrBytes`       | `1048576`   | 0       | 33554432     |
| `maxStdinBytes`        | `1048576`   | 0       | 16777216     |
| `maxSnapshotEntries`   | `10000`     | 1       | 10000        |
| `maxSnapshotFileBytes` | `67108864`  | 1       | 67108864     |
| `maxSnapshotBytes`     | `268435456` | 1       | 268435456    |

Timeouts must satisfy:

```text
stepTimeoutMs <= caseTimeoutMs <= armTimeoutMs <= suiteTimeoutMs
```

`maxSnapshotFileBytes` cannot exceed `maxSnapshotBytes`. Hitting a time, process-output, fixture,
or snapshot bound invalidates the affected arm; it is never silently truncated into a passing
oracle observation.

## Commands

### Full command

`adapter.run`, every `adapter.setup`/`adapter.reset` entry, and every `case.setup` entry are full
commands:

```json
{
  "program": {
    "lookup": "node"
  },
  "argv": [
    {
      "path": {
        "base": "suite",
        "path": "agent.mjs"
      }
    }
  ],
  "cwd": {
    "base": "state",
    "root": "memory",
    "path": "."
  },
  "env": {
    "set": {
      "MODE": "eval"
    },
    "unset": []
  },
  "stdin": {
    "kind": "none"
  },
  "timeoutMs": 30000
}
```

| Field       | Required | Default                                |
| ----------- | -------- | -------------------------------------- |
| `program`   | yes      | —                                      |
| `argv`      | no       | `[]`                                   |
| `cwd`       | no       | `"."` in the first declared state root |
| `env`       | no       | `{ "set": {}, "unset": [] }`           |
| `stdin`     | no       | `{ "kind": "none" }`                   |
| `timeoutMs` | no       | `execution.stepTimeoutMs`              |

A command has at most 128 arguments, 16 KiB per argument, and 64 KiB of unresolved argv data.
`timeoutMs` is between 100 and `execution.stepTimeoutMs`.

### Program resolution

`program` is exactly one of:

```json
{ "lookup": "node" }
```

```json
{ "path": "bin/agent-runner" }
```

`lookup` is a portable bare ASCII executable name of at most 64 characters. Shell-script shims
ending `.bat`, `.cmd`, or `.ps1` are rejected. `"node"` resolves to the current Node.js executable;
other names must resolve to exactly one real executable through the host `PATH`. An ambiguous
lookup fails closed.

`path` names a regular, non-link executable relative to the suite directory. On POSIX it must have
execute permission. Commands are launched directly with argv; GhostCase never invokes a shell.

### Standard input

`stdin` is one of:

```json
{ "kind": "none" }
```

```json
{ "kind": "text", "value": "{\"request\":\"hello\"}\n" }
```

```json
{
  "kind": "file",
  "path": {
    "path": {
      "base": "suite",
      "path": "fixtures/request.json"
    }
  }
}
```

File stdin must be a stable regular non-link file, stay inside its typed-path root, and fit
`maxStdinBytes`. `doctor` checks path resolution, `lstat`/`realpath` metadata, containment, file
type, link status, and size, but intentionally does not open or read the contents; an actual `run`
performs the same metadata checks before its bounded read. A missing `suite` file fails `doctor`.
A missing `state` or `temp` file is treated as an unmaterialized dynamic input because setup may
create it; if it already exists, `doctor` applies the complete metadata checks.

### Adapter/case merge

Each case's `run` is a patch, not a full command:

```json
{
  "argv": ["victim"],
  "cwd": {
    "base": "state",
    "root": "memory",
    "path": "."
  },
  "env": {
    "set": {
      "CASE_MODE": "strict"
    },
    "unset": ["MODE"]
  },
  "stdin": {
    "kind": "none"
  },
  "timeoutMs": 5000
}
```

Merge rules are deterministic:

- case `argv` is appended to `adapter.run.argv`;
- case `env.unset` removes an adapter command value;
- case `env.set` replaces an adapter command value with the same name;
- case `cwd`, `stdin`, and `timeoutMs` replace the adapter value when present; and
- cases cannot replace `program`.

An omitted `case.run` is an empty patch. Adapter setup/reset allow at most 16 commands each; case
setup allows at most eight.

## Adapter lifecycle

```json
{
  "setup": [],
  "run": {
    "program": {
      "lookup": "node"
    },
    "argv": [
      {
        "path": {
          "base": "suite",
          "path": "agent.mjs"
        }
      }
    ]
  },
  "oracle": {
    "kind": "exitCodeEquals",
    "value": 0
  },
  "snapshot": {
    "roots": [
      {
        "root": "memory"
      }
    ]
  },
  "reset": []
}
```

`run` and `snapshot` are required. `setup` and `reset` default to empty arrays. `oracle` defaults
to `{ "kind": "exitCodeEquals", "value": 0 }`.

Every arm executes:

1. materialize a new clone of the prepared seed;
2. run adapter setup commands, all of which must exit zero;
3. snapshot configured state roots as the residue baseline;
4. for each predecessor, run its case setup and merged command; its oracle must pass;
5. snapshot the same roots immediately before the victim;
6. diff baseline versus pre-victim state;
7. run the victim's case setup, merged command, and oracle;
8. run adapter reset; and
9. remove the materialized arm.

Reset and cleanup are attempted even after an invalid arm. Residue therefore excludes adapter
setup and victim writes: it describes only changes present after the selected predecessor chain.

## Cases

```json
{
  "id": "victim",
  "description": "Must start with neutral memory.",
  "platforms": ["linux", "win32"],
  "tags": ["victim"],
  "setup": [],
  "run": {
    "argv": ["victim"]
  },
  "oracle": {
    "kind": "stdoutJsonPointerEquals",
    "pointer": "/ok",
    "equals": true
  }
}
```

| Field         | Required | Default                 |
| ------------- | -------- | ----------------------- |
| `id`          | yes      | —                       |
| `description` | no       | `""`                    |
| `platforms`   | no       | `["win32", "linux"]`    |
| `tags`        | no       | `[]`                    |
| `setup`       | no       | `[]`                    |
| `run`         | no       | empty adapter-run patch |
| `oracle`      | no       | adapter oracle          |

`platforms` contains one or both supported names without duplicates. Ineligible predecessors are
removed from a victim's search window. An ineligible victim is `INCONCLUSIVE`.

## Oracles

Oracles are deterministic data assertions; there is no LLM judge.

### Exit code

```json
{
  "kind": "exitCodeEquals",
  "value": 0
}
```

### JSON on stdout

```json
{
  "kind": "stdoutJsonPointerEquals",
  "pointer": "/result/ok",
  "equals": true
}
```

Stdout must be a complete, untruncated strict JSON document. `pointer` is an RFC 6901 JSON Pointer;
the empty string selects the whole document. Equality is structural strict-JSON equality.

### JSON file

```json
{
  "kind": "fileJsonPointerEquals",
  "path": "result.json",
  "pointer": "/status",
  "equals": "ready"
}
```

The portable file path is relative to the resolved command `cwd`, not the suite directory. Each
component is checked without following links, and the file must remain stable during its bounded
read.

### Composition

```json
{
  "kind": "all",
  "rules": [
    {
      "kind": "exitCodeEquals",
      "value": 0
    },
    {
      "kind": "not",
      "rule": {
        "kind": "stdoutJsonPointerEquals",
        "pointer": "/unsafe",
        "equals": true
      }
    }
  ]
}
```

- `all.rules`: one to 64 rules; all must pass.
- `any.rules`: one to 64 rules; at least one must pass.
- `not.rule`: inverts pass/fail and preserves invalid.

Oracle trees are limited to depth 32 and 1024 nodes. Evaluation produces a semantic signature
from the normalized spec and all assertion outcomes/actuals. Raw stdout and file contents are not
placed in the public report.

## Snapshot roots and residue

`adapter.snapshot.roots` must contain one to 16 unique declared state-root IDs:

```json
{
  "roots": [
    {
      "root": "memory"
    },
    {
      "root": "cache"
    }
  ]
}
```

Snapshots walk only the selected materialized roots. They fail closed on links/junctions, detected
escapes, unsupported file types, unstable metadata/content, or configured bounds. Files are
content-hashed; directories and file identities are deterministically ordered.

The evidence projection exposes a root alias, a change kind (`added`, `modified`, `removed`, or
`type_changed`), and a deterministic SHA-256 `subjectId` derived from alias plus relative path.
The path itself is intentionally omitted. This residue supports the behavioral counterfactual; it
does not prove which byte or record caused the victim shift.

## Search algorithm

For each selected victim:

1. Take cases before the victim in manifest order.
2. Remove cases not applicable to the current platform.
3. Keep the nearest `maxChainLength` candidates. If older candidates are omitted, the window is
   marked truncated.
4. Evaluate the victim with an empty chain to establish the stable fresh arm.
5. Scan prefixes of lengths 1, 2, … exactly until the first stable shift. This does not assume
   monotonicity.
6. Apply deterministic, order-preserving `ddmin` to that failing prefix.
7. Verify single deletions. If every deletion resolves and removes the shift, minimality is
   `proven`; budget exhaustion or unresolved deletions make it `unproven`.

Candidate order is preserved, but a minimized witness can be a non-contiguous subsequence of the
failing prefix. Arm results are cached by victim plus ordered chain. `maxExperiments` is shared by
fresh checks, prefix checks, minimization, repetitions, and all requested victims.

When no shift is found in a complete window, the verdict is `CLEAN`. When no shift is found after
the window was truncated, the verdict is `INCONCLUSIVE` because an omitted older predecessor may
matter.

## Verdicts

| Fresh arm                       | Shared arm  | Verdict             |
| ------------------------------- | ----------- | ------------------- |
| stable pass                     | stable fail | `POLLUTION`         |
| stable fail                     | stable pass | `HIDDEN_DEPENDENCY` |
| same stable pass/fail, new sig  | —           | `OUTCOME_SHIFT`     |
| same stable pass/fail and sig   | —           | `CLEAN`             |
| either has differing valid sigs | —           | `NON_REPRODUCIBLE`  |
| either is incomplete/unresolved | —           | `INCONCLUSIVE`      |
| either has no valid harness run | —           | `HARNESS_ERROR`     |

`POLLUTION`, `HIDDEN_DEPENDENCY`, and `OUTCOME_SHIFT` are findings and receive an ordered
`minimalChain`.

## Evidence and replay

`run` always writes one canonical, content-addressed `ghostcase/evidence/v2` document. The default
directory is `.ghostcase/evidence`; filenames have the form:

```text
<suite-id>-<first-12-hex-of-evidence-sha256>.json
```

The envelope contains:

- the validated `ghostcase/report/v1` report;
- the GhostCase tool version;
- the manifest SHA-256;
- the exact `PreparedSuite` seed SHA-256 used by `run`;
- a `ghostcase/direct-execution-dependencies/v1` commitment; and
- a portable relative locator from the evidence directory to the manifest.

The direct-execution commitment hashes the bytes, size, executable bits, portable path, and
reference roles of every stable regular non-link suite file directly named by `program.path`,
suite-backed `stdin.file`, or a typed suite path in argv or an environment value, as those files
exist when evidence is stored after the run. One bound file is limited to 64 MiB and their aggregate
is limited to 256 MiB. A suite typed path that is absent, uninspectable, a directory, a link, or
another non-regular file remains unbound because typed values may intentionally name outputs or
directories.

The commitment does not recursively discover program imports, hash PATH-resolved host programs,
bind state/temp typed argv or environment paths, bind state/temp working directories or
working-directory-relative oracle files, bind state/temp stdin files produced during setup or
earlier cases, or prove that a configured command did not self-modify suite files during earlier
arms. Keep the suite tree private and read-only for the entire run. Evidence records the unique
counts as `unboundLookupPrograms`, `unboundDynamicPathReferences`,
`unboundDynamicStdinFiles`, and `unboundSuitePathReferences` so that each coverage boundary remains
explicit. Direct references are deduplicated; these counts are disclosures, not recursive
dependency inventories.

Evidence is limited to 1 MiB and is written exclusively; an existing content-addressed name is
accepted only when its bytes match exactly.

`replay` loads the evidence with the strict parser, resolves its relative manifest locator, rejects
a changed manifest, prepared seed, direct dependency commitment, or suite ID, and runs only the
recorded fresh/shared witness. Every predecessor must still occur before the victim in strictly
increasing manifest order. If the victim or any recorded predecessor excludes the current host
platform, replay runs no commands for that witness and reports `INCONCLUSIVE` with exit code 3.
Otherwise replay compares the verdict, fresh/shared summaries, ordered minimal chain, and complete
deterministically ordered `stateChanges`. It does not repeat prefix search or `ddmin`.

Legacy `ghostcase/evidence/v1` files are rejected because they contain neither a prepared-seed
commitment nor the direct dependency coverage boundary; rerun the suite to generate v2 evidence.

## Reports and exit codes

`validate`, `inspect`, and `doctor` support `human` and `json`. `run` and `replay` also support
JUnit XML and SARIF 2.1.0. `--output -` writes stdout; a file path must name a new file whose parent
already exists.

CLI exit codes:

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Healthy/no dependency, or a replay reproduced the recorded witness.      |
| `1`  | `run` confirmed a dependency or stable outcome shift; replay mismatch.   |
| `2`  | Invalid CLI input, manifest, fixture/evidence, or stale source digest.   |
| `3`  | Harness failure, abort, timeout, non-reproducibility, or inconclusivity. |

For `replay`, a current report with `exitCode: 3` makes the CLI exit 3. Otherwise the CLI exits 0
when the recorded witness matches and 1 when it does not. The `exitCode` embedded in that current
report still describes the observation itself—a reproduced pollution report remains a finding
with `exitCode: 1`, while a mismatch that now observes `CLEAN` has report `exitCode: 0`.

## Complete runnable example

Create these two files in one directory.

`ghostcase.json`:

```json
{
  "schema": "ghostcase/suite/v1",
  "suite": {
    "id": "memory-leak-demo",
    "description": "A leaked persona makes a later agent evaluation observe the wrong memory.",
    "repetitions": 2,
    "search": {
      "maxChainLength": 8,
      "maxExperiments": 64
    }
  },
  "stateRoots": [
    {
      "id": "memory",
      "seed": {
        "kind": "empty"
      }
    }
  ],
  "execution": {
    "stepTimeoutMs": 5000,
    "caseTimeoutMs": 10000,
    "armTimeoutMs": 30000,
    "suiteTimeoutMs": 120000,
    "cleanupTimeoutMs": 10000,
    "maxStdoutBytes": 65536,
    "maxStderrBytes": 65536,
    "maxStdinBytes": 65536,
    "maxSnapshotEntries": 256,
    "maxSnapshotFileBytes": 1048576,
    "maxSnapshotBytes": 4194304
  },
  "adapter": {
    "run": {
      "program": {
        "lookup": "node"
      },
      "argv": [
        {
          "path": {
            "base": "suite",
            "path": "agent.mjs"
          }
        }
      ],
      "cwd": {
        "base": "state",
        "root": "memory",
        "path": "."
      }
    },
    "oracle": {
      "kind": "stdoutJsonPointerEquals",
      "pointer": "/ok",
      "equals": true
    },
    "snapshot": {
      "roots": [
        {
          "root": "memory"
        }
      ]
    }
  },
  "cases": [
    {
      "id": "noise",
      "description": "Warms an unrelated cache entry.",
      "tags": ["control"],
      "run": {
        "argv": ["noise"]
      }
    },
    {
      "id": "polluter",
      "description": "Leaks a pirate persona into persistent memory.",
      "tags": ["memory-writer"],
      "run": {
        "argv": ["polluter"]
      }
    },
    {
      "id": "victim",
      "description": "Must start with neutral memory.",
      "tags": ["victim"],
      "run": {
        "argv": ["victim"]
      }
    }
  ]
}
```

`agent.mjs`:

```js
import { readFile, writeFile } from 'node:fs/promises';

const caseId = process.argv[2];

async function readPersona() {
  try {
    const raw = await readFile('profile.json', 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.persona === 'string' ? parsed.persona : 'unknown';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'neutral';
    }
    throw error;
  }
}

switch (caseId) {
  case 'noise': {
    await writeFile('cache.json', JSON.stringify({ warmedBy: 'noise' }), 'utf8');
    process.stdout.write(`${JSON.stringify({ caseId, ok: true })}\n`);
    break;
  }
  case 'polluter': {
    await writeFile(
      'profile.json',
      JSON.stringify({ persona: 'pirate', writtenBy: 'polluter' }),
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({ caseId, ok: true })}\n`);
    break;
  }
  case 'victim': {
    const persona = await readPersona();
    process.stdout.write(
      `${JSON.stringify({
        caseId,
        observedPersona: persona,
        ok: persona === 'neutral',
      })}\n`,
    );
    break;
  }
  default:
    throw new Error('Expected one of: noise, polluter, victim.');
}
```

From a source checkout:

```sh
pnpm ghostcase validate path/to/ghostcase.json
pnpm ghostcase doctor path/to/ghostcase.json
pnpm ghostcase run path/to/ghostcase.json --victim victim
```

This is the same code as the checked-in
[`examples/memory-leak`](../examples/memory-leak/ghostcase.json) fixture.
