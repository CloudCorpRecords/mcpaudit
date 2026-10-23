import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  analyzeProbe,
  auditToolsDump,
  gradeFor,
  parseCommandLine,
  parseConfig,
  scoreIssues,
  targetFromCommand,
  validateTools,
} from "../src/audit.js";
import { probeServer } from "../src/probe.js";
import type { ProbeResult } from "../src/types.js";

const goodTools = [
  {
    name: "echo_message",
    description: "Echo a message back to the caller. Use when you need to verify the channel works.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "The message to echo." } },
      required: ["message"],
    },
  },
];

function baseProbe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    connected: true,
    initializeMs: 42,
    protocolVersion: "2024-11-05",
    serverName: "fixture-good",
    serverVersion: "1.2.3",
    toolsCapability: true,
    toolsListed: true,
    toolsListMs: 5,
    tools: goodTools,
    badCallOutcome: "error",
    ...over,
  };
}

// --- validateTools ----------------------------------------------------------

test("clean tools produce no issues", () => {
  assert.deepEqual(validateTools(goodTools), []);
});

test("empty tool list is an error", () => {
  const issues = validateTools([]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "NO_TOOLS");
  assert.equal(issues[0].severity, "error");
});

test("missing description is an error, short description a warning", () => {
  const issues = validateTools([
    { name: "a_tool", inputSchema: { type: "object", properties: {} } },
    { name: "b_tool", description: "short", inputSchema: { type: "object", properties: {} } },
  ]);
  assert.ok(issues.some((i) => i.code === "DESC_MISSING" && i.tool === "a_tool"));
  assert.ok(issues.some((i) => i.code === "DESC_TOO_SHORT" && i.tool === "b_tool"));
});

test("description equal to the name is a warning", () => {
  const issues = validateTools([
    { name: "some_tool_name_here", description: "some_tool_name_here", inputSchema: { type: "object" } },
  ]);
  assert.ok(issues.some((i) => i.code === "DESC_EQUALS_NAME"));
});

test("missing and malformed schemas are errors", () => {
  const issues = validateTools([
    { name: "no_schema", description: "A tool with a proper description but no schema." },
    { name: "bad_schema", description: "A tool whose schema type is not an object type.", inputSchema: { type: "string" } },
    { name: "bad_props", description: "A tool whose properties field is an array, not an object.", inputSchema: { type: "object", properties: [] } },
  ]);
  assert.ok(issues.some((i) => i.code === "SCHEMA_MISSING" && i.tool === "no_schema"));
  assert.ok(issues.some((i) => i.code === "SCHEMA_TYPE_NOT_OBJECT" && i.tool === "bad_schema"));
  assert.ok(issues.some((i) => i.code === "SCHEMA_PROPERTIES_INVALID" && i.tool === "bad_props"));
});

test("required naming an undeclared property is a warning", () => {
  const issues = validateTools([
    {
      name: "mystery",
      description: "A tool with a required field missing from properties.",
      inputSchema: { type: "object", properties: { known: { type: "string" } }, required: ["nope"] },
    },
  ]);
  assert.ok(issues.some((i) => i.code === "SCHEMA_REQUIRED_UNKNOWN"));
});

test("duplicate tool names are an error", () => {
  const issues = validateTools([
    { name: "dup", description: "First copy of a duplicated tool name.", inputSchema: { type: "object" } },
    { name: "dup", description: "Second copy of a duplicated tool name.", inputSchema: { type: "object" } },
  ]);
  assert.ok(issues.some((i) => i.code === "NAME_DUPLICATE"));
});

test("invalid characters in a tool name are a warning", () => {
  const issues = validateTools([
    { name: "has spaces!", description: "A tool with a name clients may reject outright.", inputSchema: { type: "object" } },
  ]);
  assert.ok(issues.some((i) => i.code === "NAME_INVALID"));
});

test("unnamed tool is an error and does not crash the validator", () => {
  const issues = validateTools([{ description: "No name at all on this tool entry." }]);
  assert.ok(issues.some((i) => i.code === "NAME_MISSING"));
});

test("a tool whose parameters are all undescribed gets a warning", () => {
  const issues = validateTools([
    {
      name: "opaque",
      description: "A tool whose parameters carry no descriptions at all.",
      inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    },
  ]);
  assert.ok(issues.some((i) => i.code === "PARAMS_UNDESCRIBED"));
});

// --- scoring / verdicts -----------------------------------------------------

test("scoring math: error -8, warning -3, info -0, floor 0", () => {
  assert.equal(scoreIssues([]), 100);
  assert.equal(
    scoreIssues([
      { code: "A", severity: "error", detail: "" },
      { code: "B", severity: "warning", detail: "" },
      { code: "C", severity: "info", detail: "" },
    ]),
    89,
  );
  assert.equal(
    scoreIssues(Array.from({ length: 30 }, () => ({ code: "A", severity: "error" as const, detail: "" }))),
    0,
  );
  assert.equal(gradeFor(100), "A");
  assert.equal(gradeFor(75), "B");
  assert.equal(gradeFor(60), "C");
  assert.equal(gradeFor(40), "D");
  assert.equal(gradeFor(39), "F");
});

test("clean probe passes with score 100", () => {
  const r = analyzeProbe("fixture", baseProbe());
  assert.equal(r.verdict, "PASS");
  assert.equal(r.score, 100);
  assert.equal(r.issues.length, 0);
});

test("unreachable probe is UNREACHABLE with score 0", () => {
  const r = analyzeProbe("nope", {
    connected: false,
    connectError: "spawn ENOENT",
    toolsListed: false,
    tools: [],
    badCallOutcome: "skipped",
  });
  assert.equal(r.verdict, "UNREACHABLE");
  assert.equal(r.score, 0);
  assert.equal(r.issues[0].code, "UNREACHABLE");
});

test("unknown protocol version warns, missing fails", () => {
  const warn = analyzeProbe("x", baseProbe({ protocolVersion: "2999-01-01" }));
  assert.equal(warn.verdict, "WARN");
  const fail = analyzeProbe("x", baseProbe({ protocolVersion: undefined }));
  assert.equal(fail.verdict, "FAIL");
});

test("bad call accepted is an error; bad call crash is an error; timeout warns", () => {
  assert.equal(analyzeProbe("x", baseProbe({ badCallOutcome: "success" })).verdict, "FAIL");
  assert.equal(analyzeProbe("x", baseProbe({ badCallOutcome: "crash" })).verdict, "FAIL");
  assert.equal(analyzeProbe("x", baseProbe({ badCallOutcome: "timeout" })).verdict, "WARN");
});

test("tools/list failure is a FAIL with TOOLS_LIST_FAILED", () => {
  const r = analyzeProbe("x", baseProbe({ toolsListed: false, toolsListError: "boom", tools: [] }));
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.issues.some((i) => i.code === "TOOLS_LIST_FAILED"));
});

test("slow handshake warns", () => {
  const r = analyzeProbe("x", baseProbe({ initializeMs: 9000 }));
  assert.ok(r.issues.some((i) => i.code === "HANDSHAKE_SLOW"));
});

test("offline dump audit scores without a probe", () => {
  const r = auditToolsDump("dump", goodTools);
  assert.equal(r.verdict, "PASS");
  const bad = auditToolsDump("dump", []);
  assert.equal(bad.verdict, "FAIL");
});

// --- parsing ----------------------------------------------------------------

test("parseCommandLine honors quotes", () => {
  assert.deepEqual(parseCommandLine('npx -y "@scope/pkg" mcp'), ["npx", "-y", "@scope/pkg", "mcp"]);
  assert.deepEqual(parseCommandLine("node 'my server.js' --flag"), ["node", "my server.js", "--flag"]);
  assert.deepEqual(parseCommandLine(""), []);
});

test("parseConfig reads mcpServers, skips entries without a command", async () => {
  const text = await readFile(new URL("./fixtures/sample-config.json", import.meta.url), "utf8");
  const targets = parseConfig(text);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.label).sort(), ["broken", "good"]);
  const only = parseConfig(text, "good");
  assert.equal(only.length, 1);
  assert.equal(only[0].command, "node");
});

test("parseConfig accepts a bare {command, args} object and rejects junk", () => {
  const t = parseConfig(JSON.stringify({ command: "node", args: ["s.js"] }));
  assert.equal(t.length, 1);
  assert.throws(() => parseConfig("not json"));
  assert.throws(() => parseConfig(JSON.stringify({ mcpServers: {} })));
});

test("targetFromCommand rejects an empty command", () => {
  assert.throws(() => targetFromCommand([]));
});

// --- live probes against fixtures -------------------------------------------

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

test("probe: good fixture server passes end to end", async () => {
  const probe = await probeServer(
    { label: "good", command: process.execPath, args: [fixture("good-server.mjs")] },
    { timeoutMs: 10000 },
  );
  assert.equal(probe.connected, true, probe.connectError);
  assert.equal(probe.serverName, "fixture-good");
  assert.equal(probe.tools.length, 2);
  assert.equal(probe.badCallOutcome, "error");
  const report = analyzeProbe("good", probe);
  assert.equal(report.verdict, "PASS", JSON.stringify(report.issues));
  assert.equal(report.score, 100);
});

test("probe: broken fixture server fails with the expected findings", async () => {
  const probe = await probeServer(
    { label: "broken", command: process.execPath, args: [fixture("broken-server.mjs")] },
    { timeoutMs: 10000 },
  );
  assert.equal(probe.connected, true, probe.connectError);
  assert.equal(probe.badCallOutcome, "success");
  const report = analyzeProbe("broken", probe);
  assert.equal(report.verdict, "FAIL");
  const codes = new Set(report.issues.map((i) => i.code));
  for (const code of [
    "DESC_MISSING",
    "SCHEMA_MISSING",
    "NAME_DUPLICATE",
    "SCHEMA_REQUIRED_UNKNOWN",
    "BAD_CALL_ACCEPTED",
    "TOOLS_CAPABILITY_MISSING",
    "SERVER_VERSION_MISSING",
  ]) {
    assert.ok(codes.has(code), `expected ${code}, got ${[...codes].join(",")}`);
  }
  assert.ok(report.score < 60, `score ${report.score}`);
});

test("probe: unsupported protocol version is UNREACHABLE with the reason kept", async () => {
  const probe = await probeServer(
    { label: "oldproto", command: process.execPath, args: [fixture("oldproto-server.mjs")] },
    { timeoutMs: 5000 },
  );
  assert.equal(probe.connected, false);
  assert.match(probe.connectError ?? "", /protocol version is not supported/i);
  assert.equal(analyzeProbe("oldproto", probe).verdict, "UNREACHABLE");
});

test("probe: nonexistent command is UNREACHABLE, not a crash of the auditor", async () => {
  const probe = await probeServer(
    { label: "ghost", command: "mcpaudit-no-such-binary-zz9", args: [] },
    { timeoutMs: 5000 },
  );
  assert.equal(probe.connected, false);
  const report = analyzeProbe("ghost", probe);
  assert.equal(report.verdict, "UNREACHABLE");
  assert.equal(report.score, 0);
});
