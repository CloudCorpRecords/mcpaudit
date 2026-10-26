# Changelog

## 0.1.2 (2026-10-25)

Cold-start handshake tuning, from the fleet audit finding that the scored HANDSHAKE_SLOW warnings in the external index runs were all cold-start artifacts (WARN/97 on otherwise clean servers). Initialize time is measured from spawn, so it cannot by itself tell a slow server from a slow launch path; tools/list can, because it is measured against the already running server. A >30s initialize is now scored as a warning only when tools/list is also slow (>5s) or no tools/list timing exists to corroborate with. When tools/list answered within 5s, the slow initialize is reported as unscored info evidence that names both measurements and attributes the time to the launch path (launcher startup or first-run downloads). 40 tests passing.

Note on the other audit lead: this repo contains no external server index artifact to refresh (the index seed referenced in the README was an external run record, not a file in this repo), so no index results were regenerated or changed here.

## 0.1.1 (2026-10-22)

Earned fixes from the first real-production validation battery: 25+ external
MCP servers (official Node and Python servers, third-party servers, remote
endpoints, and chaos fixtures) audited with the published 0.1.0 binary, three
runs each, findings hand-checked against raw tools/list ground truth.

- **Server arguments starting with `--` now pass through verbatim.** The CLI
  previously deleted every `--*` token from the server command and stranded
  the values, corrupting launches for servers that need `--repository`,
  `--db-path`, `--headless`, etc. (mcp-server-git was unauditable via the CLI
  while the same server audited fine via `--config`). Only mcpaudit's own
  flags are extracted now, and a literal `--` forces everything after it
  into the server command.
- **Prompt/resource-only servers are no longer failed for having no tools.**
  The probe now lists prompts/resources when the server advertises them; a
  server serving prompts/resources instead of tools gets an informational
  note and can PASS. Zero tools with no other surface is a warning; zero
  tools despite advertising a tools capability remains an error.
- **Default per-step timeout raised from 15s to 60s.** Healthy servers
  launched through uvx/npx cold starts measured 25-40s to initialize and
  were reported UNREACHABLE at the old default. Timeout verdicts now carry
  a hint that the timeout covers launcher startup and how to raise it.
- **Remote (HTTP) servers are reported, not silently skipped or spawned.**
  Config entries with a `url` (Claude, Cursor, and VS Code shapes) now
  produce an UNREACHABLE report explaining mcpaudit audits stdio servers,
  whether they appear alone or mixed into a config; a URL passed as a CLI
  command gets the same explanation instead of `spawn … ENOENT`.
- **`--json` output is always one parseable document.** Multi-server config
  runs now emit a JSON array instead of concatenated objects.
- HANDSHAKE_SLOW findings now state that initialize time includes launcher
  (npx/uvx) startup; the duplicated UNREACHABLE summary line in text reports
  is removed; the probe's client version tracks the package version.
- **Initialize time no longer decides verdicts by itself.** The battery
  proved the old warning-at-3s rule scored the audit machine, not the
  server: no healthy server scored PASS in any 0.1.0 run (a ground-truth-
  clean server scored WARN/97 from launcher latency alone). Initialize
  time is now reported as unscored evidence, and only an extreme handshake
  (>30s) is scored as a warning.
- Partial parameter-description gaps are now reported (info level, naming
  the parameters) instead of only the all-parameters-undescribed case —
  the battery found the partial shape on real filesystem/everything tools.
- Regression corpus: the battery fixtures (prompt/resource-only server,
  stdout-banner server, 600-tool server) joined the test suite; 36 tests.

## 0.1.0 (2026-10-22)

First release. Wave 1, package 4 of the 100-packages plan.

- `mcpaudit audit <command...>` / `--config <file>` / `--cmdline "<line>"`: launches
  an MCP server over stdio and audits it end to end — initialize handshake and
  protocol version, serverInfo name/version, tools/list timing, per-tool name /
  description / inputSchema validation (missing descriptions, schemas that are
  not objects, `required` fields that do not exist, duplicate names, parameters
  with no descriptions), and error handling, proven by calling a tool name that
  does not exist.
- Scored report: 0-100 score and A-F grade, PASS / WARN / FAIL / UNREACHABLE
  verdict, exit code 0 or 1, `--json` for machine-readable output. An unreachable
  server is UNREACHABLE with the launch error as evidence, never a guessed score.
- `mcpaudit tools <tools.json>`: the same schema/description validation run
  offline against a tools/list dump.
- MCP server with `audit_server`, `audit_config`, and `audit_tools` tools.
- Deterministic core: no LLM anywhere in the audit path. Every finding names
  the tool and quotes the value that was actually observed.
