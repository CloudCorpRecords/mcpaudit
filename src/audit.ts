/**
 * mcpaudit core: pure, deterministic analysis of a probe result.
 *
 * No network, no spawning, no LLM. The probe layer (probe.ts) talks to a
 * server and fills a ProbeResult; everything in this file is a function of
 * that data, so the whole scoring path is testable with fixtures.
 *
 * Scoring: start at 100. error = -8, warning = -3, info = -0.
 * Verdict: UNREACHABLE when the handshake never completed; FAIL when any
 * error-severity issue exists or score < 60; WARN when any warning exists
 * or score < 90; otherwise PASS.
 */
import type {
  AuditIssue,
  AuditReport,
  ProbeResult,
  RawTool,
  ServerTarget,
  Verdict,
} from "./types.js";

export const VERSION = "0.1.2";

/** Protocol versions this build knows about (warn, never fail, on newer ones). */
export const KNOWN_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

const SEVERITY_COST: Record<string, number> = { error: 8, warning: 3, info: 0 };

export function gradeFor(score: number): AuditReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function scoreIssues(issues: AuditIssue[]): number {
  const cost = issues.reduce((sum, i) => sum + (SEVERITY_COST[i.severity] ?? 0), 0);
  return Math.max(0, 100 - cost);
}

export function verdictFor(connected: boolean, issues: AuditIssue[], score: number): Verdict {
  if (!connected) return "UNREACHABLE";
  if (issues.some((i) => i.severity === "error") || score < 60) return "FAIL";
  if (issues.some((i) => i.severity === "warning") || score < 90) return "WARN";
  return "PASS";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one tools/list array. Pure; exported for tests and the MCP tool. */
export function validateTools(tools: RawTool[]): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!Array.isArray(tools) || tools.length === 0) {
    issues.push({
      code: "NO_TOOLS",
      severity: "error",
      detail: "Server reported zero tools in tools/list. An MCP server with no tools gives a client nothing to call.",
    });
    return issues;
  }

  const seen = new Map<string, number>();
  for (const raw of tools) {
    const t = isPlainObject(raw) ? raw : {};
    const name = typeof t.name === "string" ? t.name : undefined;
    const label = name ?? "(unnamed tool)";

    if (!name) {
      issues.push({
        code: "NAME_MISSING",
        severity: "error",
        tool: label,
        detail: "Tool has no string `name`. Clients address tools by name; this tool is uncallable.",
        evidence: JSON.stringify(t).slice(0, 120),
      });
      continue;
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      issues.push({
        code: "NAME_INVALID",
        severity: "warning",
        tool: name,
        detail: "Tool name falls outside the MCP guidance of 1-64 chars from [A-Za-z0-9._-]. Some clients reject or mangle such names.",
        evidence: name,
      });
    }

    const desc = typeof t.description === "string" ? t.description.trim() : "";
    if (!desc) {
      issues.push({
        code: "DESC_MISSING",
        severity: "error",
        tool: name,
        detail: "Tool has no description. The description is how a model decides when to call this tool; without one the tool is effectively invisible.",
      });
    } else if (desc.length < 16) {
      issues.push({
        code: "DESC_TOO_SHORT",
        severity: "warning",
        tool: name,
        detail: `Tool description is only ${desc.length} character${desc.length === 1 ? "" : "s"}. That is rarely enough for a model to know when (and when not) to call it.`,
        evidence: desc,
      });
    } else if (desc === name) {
      issues.push({
        code: "DESC_EQUALS_NAME",
        severity: "warning",
        tool: name,
        detail: "Tool description just repeats the tool name, so it teaches the model nothing.",
        evidence: desc,
      });
    }

    const schema = t.inputSchema;
    if (schema === undefined || schema === null) {
      issues.push({
        code: "SCHEMA_MISSING",
        severity: "error",
        tool: name,
        detail: "Tool has no inputSchema. Clients cannot validate arguments before calling.",
      });
    } else if (!isPlainObject(schema)) {
      issues.push({
        code: "SCHEMA_NOT_OBJECT",
        severity: "error",
        tool: name,
        detail: "inputSchema is not a JSON Schema object.",
        evidence: JSON.stringify(schema).slice(0, 120),
      });
    } else {
      if (schema.type !== undefined && schema.type !== "object") {
        issues.push({
          code: "SCHEMA_TYPE_NOT_OBJECT",
          severity: "error",
          tool: name,
          detail: `inputSchema.type is ${JSON.stringify(schema.type)}; MCP tool input schemas must describe an object.`,
          evidence: JSON.stringify(schema.type),
        });
      }
      const props = schema.properties;
      if (props !== undefined && !isPlainObject(props)) {
        issues.push({
          code: "SCHEMA_PROPERTIES_INVALID",
          severity: "error",
          tool: name,
          detail: "inputSchema.properties is present but is not an object of property schemas.",
          evidence: JSON.stringify(props).slice(0, 120),
        });
      }
      if (Array.isArray(schema.required)) {
        const propNames = isPlainObject(props) ? Object.keys(props) : [];
        for (const req of schema.required) {
          if (typeof req === "string" && !propNames.includes(req)) {
            issues.push({
              code: "SCHEMA_REQUIRED_UNKNOWN",
              severity: "warning",
              tool: name,
              detail: `inputSchema.required lists "${req}" but properties has no such key, so no valid argument object can be built from the schema alone.`,
              evidence: req,
            });
          }
        }
      }
      if (schema.type === "object" && (props === undefined || (isPlainObject(props) && Object.keys(props).length === 0))) {
        issues.push({
          code: "SCHEMA_NO_PROPERTIES",
          severity: "info",
          tool: name,
          detail: "Tool schema declares no properties. That is correct for a no-argument tool, but worth confirming it is intentional.",
        });
      }
      // Property-level description check: undescribed parameters are a
      // recurring real-world cause of models passing garbage arguments.
      if (isPlainObject(props)) {
        const undescribed = Object.entries(props)
          .filter(([, v]) => !(isPlainObject(v) && typeof v.description === "string" && v.description.trim().length > 0))
          .map(([k]) => k);
        if (undescribed.length > 0 && Object.keys(props).length > 0 && undescribed.length === Object.keys(props).length) {
          issues.push({
            code: "PARAMS_UNDESCRIBED",
            severity: "warning",
            tool: name,
            detail: `None of this tool's ${undescribed.length} parameter(s) carry a description. Models guess argument semantics from descriptions.`,
            evidence: undescribed.slice(0, 8).join(", "),
          });
        } else if (undescribed.length > 0) {
          // Partial gaps are real (production validation found them on
          // filesystem/everything tools) but weaker evidence than a fully
          // undocumented tool — info level, naming the parameters.
          issues.push({
            code: "PARAMS_PARTIALLY_UNDESCRIBED",
            severity: "info",
            tool: name,
            detail: `${undescribed.length} of this tool's ${Object.keys(props).length} parameter(s) carry no description: ${undescribed.slice(0, 8).join(", ")}. Models guess those arguments' semantics.`,
            evidence: undescribed.slice(0, 8).join(", "),
          });
        }
      }
    }
  }

  for (const [name, count] of seen) {
    if (count > 1) {
      issues.push({
        code: "NAME_DUPLICATE",
        severity: "error",
        tool: name,
        detail: `Tool name "${name}" appears ${count} times in tools/list. Clients cannot address the duplicates unambiguously.`,
        evidence: name,
      });
    }
  }
  return issues;
}

/** Turn a completed probe into issues + score + verdict. Pure. */
export function analyzeProbe(target: string, probe: ProbeResult): AuditReport {
  const issues: AuditIssue[] = [];
  const checkedAt = new Date().toISOString();

  if (!probe.connected) {
    let detail = `Server did not complete the MCP initialize handshake. ${probe.connectError ?? ""}`.trim();
    if (/timed out/i.test(probe.connectError ?? "")) {
      detail +=
        " Hint: the timeout covers the whole launch path — a server started through npx/uvx can spend longer than this on first-run package downloads alone. Re-run with a larger --timeout (for example --timeout 90000) before concluding the server is dead.";
    }
    issues.push({
      code: "UNREACHABLE",
      severity: "error",
      detail,
      evidence: probe.connectError,
    });
    return {
      target,
      verdict: "UNREACHABLE",
      score: 0,
      grade: "F",
      issues,
      summary: {
        connected: false,
        toolCount: 0,
        badCallOutcome: probe.badCallOutcome,
        errors: 1,
        warnings: 0,
      },
      checkedAt,
    };
  }

  if (!probe.protocolVersion) {
    issues.push({
      code: "PROTOCOL_VERSION_MISSING",
      severity: "error",
      detail: "Initialize result carried no protocolVersion. Clients negotiate behavior off this field.",
    });
  } else if (!KNOWN_PROTOCOL_VERSIONS.includes(probe.protocolVersion)) {
    issues.push({
      code: "PROTOCOL_VERSION_UNKNOWN",
      severity: "warning",
      detail: `Server negotiated protocol version ${probe.protocolVersion}, which this mcpaudit build does not know. It may be newer than the auditor — verify by hand.`,
      evidence: probe.protocolVersion,
    });
  }
  if (!probe.serverName) {
    issues.push({
      code: "SERVER_NAME_MISSING",
      severity: "warning",
      detail: "Initialize result carried no serverInfo.name. Clients and registries display this; an anonymous server is hard to trust or debug.",
    });
  }
  if (!probe.serverVersion) {
    issues.push({
      code: "SERVER_VERSION_MISSING",
      severity: "warning",
      detail: "Initialize result carried no serverInfo.version. Without it, users cannot tell which build they are talking to.",
    });
  }
  if (probe.initializeMs !== undefined && probe.initializeMs > 3000) {
    // Initialize time is measured from spawn, so it includes launcher
    // (npx/uvx) startup and first-run downloads: production validation
    // measured healthy servers at 3-26s through their documented launch
    // commands, and the old warning-at-3s rule scored the audit machine,
    // not the server (no healthy server could PASS). The measurement is
    // reported as evidence at info level; only an extreme handshake
    // (>30s, where real clients genuinely start timing out even after
    // warm starts) is scored as a warning.
    //
    // Cold-start corroboration: initialize alone cannot tell a slow
    // server from a slow launch path, but tools/list can. It is measured
    // after the handshake, against the already running server, so a fast
    // tools/list (<=5s) under a >30s initialize proves the server itself
    // answers promptly once it is up: the 30s+ went to the launcher or to
    // first-run downloads, and scoring it would repeat the WARN/97
    // cold-start false positives the fleet audit found (every one of
    // those servers was otherwise clean). The warning now requires the
    // server to be slow in its own right: tools/list also slow (>5s),
    // or no tools/list timing to corroborate with.
    const extreme = probe.initializeMs > 30000;
    const listMs = probe.toolsListMs;
    const serverResponsive = listMs !== undefined && listMs <= 5000;
    const scored = extreme && !serverResponsive;
    issues.push({
      code: "HANDSHAKE_SLOW",
      severity: scored ? "warning" : "info",
      detail: scored
        ? `Initialize took ${Math.round(probe.initializeMs)}ms and tools/list took ${listMs !== undefined ? `${Math.round(listMs)}ms` : "an unmeasured amount of time"} after that. The server itself is slow once running, not just its launch path, and a handshake this slow makes real clients time out.`
        : extreme
          ? `Initialize took ${Math.round(probe.initializeMs)}ms measured from spawn, but tools/list answered in ${Math.round(listMs as number)}ms once the server was up. The slow part was the launch path (launcher startup or first-run downloads), not the server, so this is reported as evidence, not scored. A warm start or a pre-installed server removes most of it.`
          : `Initialize took ${Math.round(probe.initializeMs)}ms measured from spawn, including launcher (npx/uvx) startup and any first-run downloads. Reported as evidence, not scored, because that latency belongs mostly to the launch path rather than the server.`,
      evidence: `${Math.round(probe.initializeMs)}ms`,
    });
  }
  // Only a contradiction is a finding: tools were listed successfully even
  // though no tools capability was advertised. A server that honestly
  // declares no tools capability and serves prompts/resources instead is
  // not "missing" anything.
  if (probe.toolsCapability === false && probe.toolsListed && probe.tools.length > 0) {
    issues.push({
      code: "TOOLS_CAPABILITY_MISSING",
      severity: "warning",
      detail: "Initialize result did not advertise a tools capability, yet tools/list returned tools. Declaring capabilities honestly prevents client confusion.",
    });
  }

  if (!probe.toolsListed) {
    issues.push({
      code: "TOOLS_LIST_FAILED",
      severity: "error",
      detail: `tools/list did not complete. ${probe.toolsListError ?? ""}`.trim(),
      evidence: probe.toolsListError,
    });
  } else {
    if (probe.strictListError) {
      issues.push({
        code: "STRICT_LIST_VALIDATION",
        severity: "warning",
        detail: "A strict client (official SDK typed tools/list) rejects this server's tool list during schema validation; only a permissive raw request could read it. The per-tool findings below name why.",
        evidence: probe.strictListError.slice(0, 200),
      });
    }
    if (probe.tools.length === 0) {
      // Zero tools is only an error when the server claimed a tools
      // surface. A prompt/resource server is a legitimate MCP server —
      // say what it actually serves instead of failing it for a feature
      // it never advertised.
      const prompts = probe.promptsCount ?? 0;
      const resources = probe.resourcesCount ?? 0;
      if (prompts > 0 || resources > 0) {
        issues.push({
          code: "PROMPTS_RESOURCES_ONLY",
          severity: "info",
          detail: `Server exposes no tools; it serves ${prompts} prompt(s) and ${resources} resource(s) instead. Tool checks do not apply to this server.`,
          evidence: `prompts=${prompts}, resources=${resources}`,
        });
      } else if (probe.toolsCapability === false) {
        issues.push({
          code: "NO_TOOLS",
          severity: "warning",
          detail:
            "Server reported zero tools, did not advertise a tools capability, and no prompts or resources were listed either. Clients get no callable surface from this server.",
        });
      } else {
        issues.push(...validateTools(probe.tools));
      }
    } else {
      issues.push(...validateTools(probe.tools));
    }
  }

  switch (probe.badCallOutcome) {
    case "success":
      issues.push({
        code: "BAD_CALL_ACCEPTED",
        severity: "error",
        detail: "Calling a tool name that does not exist returned success. A server that invents success for unknown tools will mislead every client that mistypes.",
        evidence: probe.badCallDetail,
      });
      break;
    case "crash":
      issues.push({
        code: "BAD_CALL_CRASH",
        severity: "error",
        detail: "Calling a nonexistent tool killed the connection. Bad input must produce an error response, not a dead server.",
        evidence: probe.badCallDetail,
      });
      break;
    case "timeout":
      issues.push({
        code: "BAD_CALL_TIMEOUT",
        severity: "warning",
        detail: "Calling a nonexistent tool produced no response inside the probe window. Errors should be fast and explicit.",
        evidence: probe.badCallDetail,
      });
      break;
    case "error":
      // Correct behavior — recorded as evidence in the summary, not an issue.
      break;
    case "skipped":
      if (probe.toolsListed) {
        issues.push({
          code: "BAD_CALL_SKIPPED",
          severity: "info",
          detail: "Error-handling probe was not attempted (server state did not allow it).",
        });
      }
      break;
  }

  const score = scoreIssues(issues);
  return {
    target,
    verdict: verdictFor(true, issues, score),
    score,
    grade: gradeFor(score),
    issues,
    summary: {
      connected: true,
      protocolVersion: probe.protocolVersion,
      serverName: probe.serverName,
      serverVersion: probe.serverVersion,
      toolCount: probe.tools.length,
      promptsCount: probe.promptsCount,
      resourcesCount: probe.resourcesCount,
      initializeMs: probe.initializeMs,
      toolsListMs: probe.toolsListMs,
      badCallOutcome: probe.badCallOutcome,
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    },
    checkedAt,
  };
}

/** Offline audit: score a tools/list dump without spawning anything. */
export function auditToolsDump(target: string, tools: RawTool[]): AuditReport {
  const issues = validateTools(tools);
  const score = scoreIssues(issues);
  return {
    target,
    verdict: verdictFor(true, issues, score),
    score,
    grade: gradeFor(score),
    issues,
    summary: {
      connected: true,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      badCallOutcome: "skipped",
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    },
    checkedAt: new Date().toISOString(),
  };
}

export function renderReport(r: AuditReport): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push(`mcpaudit ${r.target}: ${r.verdict} (score ${r.score}/100, grade ${r.grade})`);
  if (!s.connected) {
    // The UNREACHABLE issue below carries the full detail; no summary line here.
  } else {
    lines.push(
      `  server: ${s.serverName ?? "(unnamed)"} ${s.serverVersion ?? ""} · protocol ${s.protocolVersion ?? "(none)"} · ${s.toolCount} tool(s)` +
        (s.promptsCount !== undefined ? ` · ${s.promptsCount} prompt(s)` : "") +
        (s.resourcesCount !== undefined ? ` · ${s.resourcesCount} resource(s)` : "") +
        (s.initializeMs !== undefined ? ` · initialize ${Math.round(s.initializeMs)}ms` : "") +
        (s.toolsListMs !== undefined ? ` · tools/list ${Math.round(s.toolsListMs)}ms` : ""),
    );
    lines.push(
      `  error handling: ${s.badCallOutcome === "error" ? "bad tool call returned a proper error" : s.badCallOutcome}`,
    );
  }
  for (const i of r.issues) {
    const tag = i.severity === "error" ? "ERROR" : i.severity === "warning" ? "WARN " : "INFO ";
    lines.push(`  [${tag}] ${i.code}${i.tool ? ` (${i.tool})` : ""}: ${i.detail}`);
  }
  if (r.issues.length === 0) lines.push(`  No issues found.`);
  lines.push(
    r.verdict === "PASS"
      ? `PASS: handshake, schemas, and error handling all check out.`
      : r.verdict === "WARN"
        ? `WARN: server works, but the issues above will cost it users or correctness.`
        : r.verdict === "FAIL"
          ? `FAIL: error-severity issues above need fixing before this server is trustworthy.`
          : `UNREACHABLE: fix the launch command/config and re-run.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Target parsing: CLI command lines and MCP client config files.
// ---------------------------------------------------------------------------

/** Split a command line the way a shell would for simple cases (quotes honored). */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur.length > 0) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur.length > 0) out.push(cur);
  return out;
}

export function targetFromCommand(argv: string[], label?: string): ServerTarget {
  if (argv.length === 0) throw new Error("Empty server command.");
  if (/^https?:\/\//i.test(argv[0])) {
    return { label: label ?? argv[0], command: "", args: [], remoteUrl: argv[0] };
  }
  return { label: label ?? argv.join(" "), command: argv[0], args: argv.slice(1) };
}

/** mcpaudit's own value-taking CLI flags for `audit` (everything else is the server's). */
export const AUDIT_VALUE_FLAGS = ["--config", "--server", "--timeout", "--cmdline"];

/**
 * Extract the server command from `audit` arguments.
 *
 * Only mcpaudit's own flags are removed (`--json`, and the value flags in
 * AUDIT_VALUE_FLAGS), wherever they appear before a `--` separator. Every
 * other token — crucially including server arguments that start with
 * `--`, such as `--repository <path>` — passes through verbatim, in
 * order. After a literal `--`, ALL tokens are the server command.
 * (Production validation P-001: the previous collector dropped every
 * `--*` token and stranded their values as stray positional arguments,
 * corrupting launches for a large share of real servers.)
 */
export function extractServerCommand(rest: string[]): string[] {
  const sep = rest.indexOf("--");
  const ownPart = sep >= 0 ? rest.slice(0, sep) : rest;
  const serverPart = sep >= 0 ? rest.slice(sep + 1) : [];
  const out: string[] = [];
  for (let i = 0; i < ownPart.length; i++) {
    const a = ownPart[i];
    if (AUDIT_VALUE_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (a === "--json") continue;
    out.push(a);
  }
  return [...out, ...serverPart];
}

/**
 * Render one or more reports as a single output document. JSON mode
 * always produces exactly one parseable JSON document: the report object
 * for a single target, an array for several. (Production validation
 * P-006: multi-server --config --json previously emitted concatenated
 * objects that no JSON parser could read.)
 */
export function formatReports(reports: AuditReport[], asJson: boolean): string {
  if (asJson) {
    return JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2);
  }
  return reports.map((r) => renderReport(r)).join("\n");
}

/**
 * Parse an MCP client config (Claude/Cursor style) or a bare server object.
 * Accepts: {"mcpServers": {name: {command, args, env}}},
 *          {"servers": {...}}, {"name": {...single...}}, or {command, args}.
 */
export function parseConfig(text: string, only?: string): ServerTarget[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(data)) throw new Error("Config must be a JSON object.");

  const maps: Record<string, unknown>[] = [];
  if (isPlainObject(data.mcpServers)) maps.push(data.mcpServers);
  if (isPlainObject(data.servers)) maps.push(data.servers);
  const targets: ServerTarget[] = [];
  for (const map of maps) {
    for (const [name, entry] of Object.entries(map)) {
      if (only && name !== only) continue;
      if (!isPlainObject(entry)) continue;
      if (typeof entry.command !== "string") {
        // Remote (HTTP/SSE) entry: surface it as a remote target so the
        // audit reports it honestly as unsupported-by-this-build instead
        // of silently skipping it (production validation P-005).
        if (typeof entry.url === "string") {
          targets.push({ label: name, command: "", args: [], remoteUrl: entry.url });
        }
        continue;
      }
      targets.push({
        label: name,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
        env: isPlainObject(entry.env)
          ? Object.fromEntries(Object.entries(entry.env).filter(([, v]) => typeof v === "string") as [string, string][])
          : undefined,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      });
    }
  }
  if (targets.length > 0) return targets;

  if (typeof data.url === "string" && typeof data.command !== "string") {
    return [{ label: only ?? "config", command: "", args: [], remoteUrl: data.url }];
  }
  if (typeof data.command === "string") {
    return [
      {
        label: only ?? "config",
        command: data.command,
        args: Array.isArray(data.args) ? data.args.filter((a): a is string => typeof a === "string") : [],
        env: isPlainObject(data.env)
          ? Object.fromEntries(Object.entries(data.env).filter(([, v]) => typeof v === "string") as [string, string][])
          : undefined,
      },
    ];
  }
  throw new Error(
    only
      ? `No server named "${only}" with a command found in config.`
      : "No server entries with a command found in config (looked for mcpServers / servers / a bare {command, args} object).",
  );
}
