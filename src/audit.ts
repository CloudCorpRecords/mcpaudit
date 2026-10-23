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

export const VERSION = "0.1.0";

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
    issues.push({
      code: "UNREACHABLE",
      severity: "error",
      detail: `Server did not complete the MCP initialize handshake. ${probe.connectError ?? ""}`.trim(),
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
    issues.push({
      code: "HANDSHAKE_SLOW",
      severity: "warning",
      detail: `Initialize took ${Math.round(probe.initializeMs)}ms. Slow handshakes make clients time out and make the server feel broken.`,
      evidence: `${Math.round(probe.initializeMs)}ms`,
    });
  }
  if (probe.toolsCapability === false) {
    issues.push({
      code: "TOOLS_CAPABILITY_MISSING",
      severity: "warning",
      detail: "Initialize result did not advertise a tools capability, yet clients will still try tools/list. Declaring capabilities honestly prevents client confusion.",
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
    issues.push(...validateTools(probe.tools));
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
    lines.push(`  [ERROR] UNREACHABLE: server did not complete the initialize handshake`);
  } else {
    lines.push(
      `  server: ${s.serverName ?? "(unnamed)"} ${s.serverVersion ?? ""} · protocol ${s.protocolVersion ?? "(none)"} · ${s.toolCount} tool(s)` +
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
  return { label: label ?? argv.join(" "), command: argv[0], args: argv.slice(1) };
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
      if (!isPlainObject(entry) || typeof entry.command !== "string") continue;
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
