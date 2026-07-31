# Security policy

## Supported versions

GhostCase is pre-release software. Until the first tagged release, only the latest `main` revision
receives security fixes. Do not assume an older commit has been backported.

## Report a vulnerability privately

Do not open a public issue for a vulnerability, exploit, credential exposure, or unsafe path
primitive. Use GitHub's private report form:

https://github.com/getio0909/ghostcase/security/advisories/new

Include the affected commit, operating system, Node.js version, a minimal synthetic reproducer,
expected behavior, and observed behavior. Remove real credentials, customer data, proprietary
prompts, and private eval output.

## Trust model

GhostCase executes programs named by a user-authored suite. It is a debugger and experiment
harness, not an operating-system sandbox.

Direct argv execution avoids shell parsing, but it is not an untrusted-code boundary. A configured
program runs with the same user identity and operating-system permissions as GhostCase. It can:

- read or modify files outside declared state roots;
- access the network;
- connect to local services;
- inspect accessible host state;
- create subprocesses or detach descendants; and
- disclose any environment value explicitly inherited by the suite.

State roots, isolated working directories, environment reduction, and process-tree termination
improve experiment repeatability. They do not constrain system calls or grant containment.

Run untrusted, third-party, or adversarial eval targets inside a disposable container or VM with a
low-privilege user, a minimal read-only mount set, disabled or allow-listed egress, resource
limits, and no ambient credentials. Treat the entire container/VM as disposable after the run.

## Credentials and environment inheritance

The default child environment inherits no user-selected host variables. `environment.inherit` is
an explicit authority boundary: if a suite lists `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or another
credential, GhostCase passes its value to every configured child command.

GhostCase omits environment values from reports, but it cannot prevent the child program from
logging, copying, or transmitting inherited values. Prefer a dedicated, narrowly scoped test
credential. Never run an untrusted suite with production credentials.

Loader- and shell-injection variables such as `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `BASH_ENV`, and `DYLD_*` cannot be inherited or set. That denylist reduces
common pre-execution injection paths; it is not a complete defense against a malicious executable.

## Filesystem hardening and limits

GhostCase uses several fail-closed checks:

- manifests, evidence, seed files, stdin files, oracle files, and snapshots are bounded;
- directly bound suite program, file-stdin, and typed argv/environment file dependencies are
  limited to 64 MiB per file and 256 MiB total;
- strict JSON rejects duplicate keys, unsafe values, and unknown schema fields;
- known symbolic links and Windows junctions are rejected in fixtures and observed roots;
- lexical paths and `realpath` values are compared at isolation boundaries;
- metadata and file identity are checked before, during, and after sensitive reads to narrow
  time-of-check/time-of-use races;
- evidence and requested report files are created exclusively instead of overwriting existing
  files; and
- command, case, arm, suite, cleanup, stream, file, entry, and aggregate byte limits are enforced.

These checks narrow races but cannot eliminate filesystem TOCTOU against another process with
write access to the same directories. Keep suite sources, seed directories, evidence directories,
and temporary roots private to the GhostCase user while a run is active.

Node's portable `lstat().isSymbolicLink()` view identifies ordinary symlinks and the junctions
covered by GhostCase's Windows tests. It does not expose every Windows reparse tag. In particular,
non-link cloud placeholders or other vendor-specific reparse points may not be distinguishable as
links by this implementation. Do not place security-sensitive runs in OneDrive/cloud-synced,
recall-on-access, deduplicated, or otherwise filter-managed trees. Use a local, non-reparse
filesystem inside the disposable execution boundary.

Process-tree termination is best effort and platform dependent. On Windows, post-exit cleanup can
follow parent-process identifiers only through processes that are still present in one system
snapshot. If `root` exits, then an intermediate child exits before the snapshot while its leaf
process remains alive, the missing `root -> intermediate -> leaf` chain cannot be reconstructed.
A bounded 250 ms grace lets linked console infrastructure retire naturally before GhostCase
terminates remaining descendants. Retained descendant handles and per-generation creation-time
ordering narrow PID-reuse races, but the exited root itself is identified by its PID and a
millisecond lifetime window rather than a retained native process handle.
A cleanup result that finds no linked descendants therefore means none were visible within this
best-effort boundary; it does not prove that no descendant survived. A child that escapes the
process group, races termination, or delegates work to an external service may also outlive the
experiment.

## Evidence and privacy

Validated reports intentionally exclude:

- raw stdout and stderr;
- environment names and values;
- absolute manifest, suite, workspace, and temporary paths;
- raw state-file paths; and
- raw file contents.

Reports and evidence still contain metadata that may be sensitive:

- suite, case, predecessor, and state-root IDs;
- manifest, semantic-signature, evidence, and optional content digests;
- change kinds and optional byte sizes;
- the portable relative manifest locator stored in evidence; and
- stable filesystem `subjectId` values.

A `subjectId` is a deterministic hash of a state-root alias and relative path. Hashing removes the
literal path but does not make a low-entropy name secret: an observer can enumerate likely aliases
and filenames and compare hashes. A relative locator can also reveal repository layout. Review
evidence before sharing it outside the team and transport it as sensitive build output.

Filesystem residue is supporting evidence: it records bounded changes present immediately before
the victim in a reproducible shared arm. It is not byte-level causal proof. It does not observe
undeclared roots, remote state, registry entries, process memory, external databases, or every
framework-specific store, and a changed file can correlate with rather than cause the behavioral
shift.

`ghostcase/evidence/v2` binds the prepared seed and stable regular non-link suite files directly
referenced as programs, file stdin, or typed argv/environment values, as observed when evidence is
stored after a run. This is not a recursive software-supply-chain snapshot, nor proof that a
configured command did not self-modify suite files during earlier arms. PATH-resolved executables,
modules imported by a program, inherited host services, state/temp typed paths, working directories
and oracle paths, dynamic stdin, and suite typed paths that are absent or not regular files remain
outside that digest. Uninspectable suite typed paths also remain unbound. Evidence discloses unique
counts for lookup programs, dynamic paths, dynamic stdin, and unbound suite paths; replay must not
be described as reproducing dependencies beyond this boundary.

## Out of scope for the harness boundary

The following are not security guarantees:

- prevention of data exfiltration by configured commands;
- isolation from the host kernel or local network;
- complete termination of hostile descendants;
- detection of every filesystem reparse mechanism;
- causal attribution inside database files or serialized stores; and
- safety of manifests or executables supplied by an untrusted party.

Reports about a concrete bypass of a documented fail-closed check are welcome. Requests to turn
GhostCase itself into a general untrusted-code sandbox require a separate threat model and are not
covered by the current execution architecture.
