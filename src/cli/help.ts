export const HELP_TEXT = `GhostCase finds deterministic cross-case state pollution in AI agent eval suites.

Usage:
  ghostcase validate [suite] [options]
  ghostcase inspect [suite] [options]
  ghostcase doctor [suite] [options]
  ghostcase run [suite] [options]
  ghostcase replay <evidence.json> [options]
  ghostcase --help
  ghostcase --version

Commands:
  validate  Validate suite syntax, semantics, and isolation boundaries without executing cases.
  inspect   Show the resolved execution plan, digests, argv contracts, and search bounds.
  doctor    Check executables and temporary clone/snapshot capabilities without running cases.
  run       Search for and minimize deterministic predecessor-to-victim dependencies.
  replay    Re-run one recorded fresh/shared witness without repeating the search.

Common options:
  --format <format>     Select the stdout or file report format. Default: human
  --output <path|->    Write the selected report to a file, or use - for stdout. Default: -
  -v, --verbose        Include attempt and minimization detail in diagnostics.

Run options:
  --victim <case-id>   Analyze only this victim. Repeat to select multiple victims.
  --evidence-dir <path>
                       Store canonical JSON evidence here. Default: .ghostcase/evidence

Output formats:
  validate, inspect, doctor: human | json
  run, replay: human | json | junit | sarif

Default suite: ghostcase.json

Top-level actions must be used by themselves. Long options require a separate value; combined short
options and --option=value forms are not accepted.
Each case runs as an argv array without a shell inside an isolated clone of the immutable seed.
Run always records canonical JSON evidence; human, JUnit, and SARIF are projections of that evidence.

Exit codes:
  0  Healthy/no dependency, or replay reproduced the witness.
  1  Confirmed dependency, or replay completed but did not match.
  2  Invalid CLI input, suite, evidence, or stale digest.
  3  Execution was incomplete or non-reproducible.
`;

export function renderHelp(): string {
  return HELP_TEXT;
}
