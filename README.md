# mcpaudit

**Point it at any MCP server. Get a score, and the receipts.**

The MCP Registry is filling up with servers nobody has ever audited. A server can list tools with no descriptions (so models never call them correctly), schemas that contradict themselves (`required` fields that don't exist), or — the dangerous one — cheerfully return success when you call a tool that doesn't exist. None of that shows up until a user's agent does something weird in production.

mcpaudit launches the server the way a real client does, runs the full handshake, inspects every tool, deliberately makes a bad call, and prints one scored report with named, evidence-backed issues. No LLM anywhere in the audit: every check is deterministic and repeatable.

## What it checks

| check | what it proves |
| --- | --- |
| handshake | The server completes `initialize` — and how long it took |
| protocol version | The negotiated version is present and one this build knows |
| server info | `serverInfo.name` and `serverInfo.version` are present |
| tool names | Present, unique, and inside the MCP character/length guidance |
| descriptions | Every tool described, in more than a token gesture, not just its own name repeated |
| input schemas | Present, an object schema, valid `properties`, `required` fields that actually exist |
| parameter docs | Tools whose parameters are *all* undescribed get flagged — models guess semantics from descriptions |
| error handling | A call to a nonexistent tool returns a proper error, fast, without killing the server |

Scoring: start at 100, each error costs 8, each warning costs 3. Verdicts: **PASS** (clean), **WARN** (works, but the issues will cost it users or correctness), **FAIL** (error-severity issues), **UNREACHABLE** (the handshake never completed — reported with the launch error, never a guessed score).

## Usage

### CLI

```bash
# Audit a server by its launch command
npx @reneturcios/mcpaudit audit npx -y @reneturcios/shipcheck mcp
npx @reneturcios/mcpaudit audit node dist/cli.js mcp

# Audit every server in an MCP client config (or one named entry)
npx @reneturcios/mcpaudit audit --config ~/.claude/claude_desktop_config.json
npx @reneturcios/mcpaudit audit --config ./mcp.json --server greenlight

# Quoted command line, machine-readable output, custom timeout
npx @reneturcios/mcpaudit audit --cmdline "npx -y @scope/pkg mcp" --json --timeout 30000

# Offline: validate a tools/list dump without launching anything
npx @reneturcios/mcpaudit tools tools.json
```

Example output:

```
mcpaudit npx -y @reneturcios/shipcheck mcp: PASS (score 100/100, grade A)
  server: shipcheck 0.1.0 · protocol 2025-03-26 · 3 tool(s) · initialize 812ms · tools/list 4ms
  error handling: bad tool call returned a proper error
  No issues found.
PASS: handshake, schemas, and error handling all check out.
```

Exit codes: 0 for PASS/WARN, 1 for FAIL/UNREACHABLE, 2 for usage errors — CI-ready.

### MCP server

Add to your MCP client config:

```json
{
  "mcpServers": {
    "mcpaudit": {
      "command": "npx",
      "args": ["-y", "@reneturcios/mcpaudit", "mcp"]
    }
  }
}
```

Tools:

- `audit_server`: launch and audit one server from a command + args (+ optional env, timeout).
- `audit_config`: audit every server in a config file, or one named entry.
- `audit_tools`: offline validation of a tools/list array.

### Docker

```bash
docker run -i ghcr.io/cloudcorprecords/mcpaudit mcp
docker run --rm ghcr.io/cloudcorprecords/mcpaudit audit node server.js mcp
```

## The MCP Server Index

mcpaudit is the engine behind a growing public dataset, the **MCP Server Index**: scored audits of real, published MCP servers, run with the published binary and refreshed as servers ship. The seed — the author's own tool family, audited first because you audit yourself before you audit anyone else — lives in the [100-packages workspace](https://github.com/CloudCorpRecords) and grows with every wave.

## The toolkit

mcpaudit is Wave 1, package 4 of a planned family of small, single-purpose developer tools by the same author, all built the same way: one bin that serves a CLI and an MCP server, deterministic checks with evidence, no invented answers.

- [greenlight](https://github.com/CloudCorpRecords/greenlight): pre-flight checks for open-source contributions: is this issue actually landable?
- [shipcheck](https://github.com/CloudCorpRecords/shipcheck): release verification — git tag, GitHub release, npm, MCP Registry, and GHCR must all agree, or NO-GO.
- [cidiff](https://github.com/CloudCorpRecords/cidiff): base-vs-head CI differ for PRs.
- [reprocheck](https://github.com/CloudCorpRecords/reprocheck): red-first repro verifier.
- [prwatch](https://github.com/CloudCorpRecords/prwatch): attention report for your open PRs.
- [claimcheck](https://github.com/CloudCorpRecords/claimcheck): stale-claim states and parked fixes on forks.
- [gatefile](https://github.com/CloudCorpRecords/gatefile): extract hidden contribution gates into machine-readable contribution-gates.json.
- [pkgverdict](https://github.com/CloudCorpRecords/pkgverdict): pre-install verdicts for npm packages: GO, RISKY, FAKE, or MISSING.

## Development

```bash
npm install
npm run build
npm test   # validator/scoring unit tests + live probes against fixture servers
```

## License

MIT
