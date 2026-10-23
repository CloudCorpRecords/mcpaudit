# Changelog

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
