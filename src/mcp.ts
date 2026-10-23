/**
 * mcpaudit MCP server. Tools: audit_server, audit_config, audit_tools.
 */
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeProbe,
  auditToolsDump,
  parseConfig,
  targetFromCommand,
  VERSION,
} from "./audit.js";
import { probeServer } from "./probe.js";
import type { RawTool } from "./types.js";

const server = new McpServer({ name: "mcpaudit", version: VERSION });

server.tool(
  "audit_server",
  "Audit an MCP server by launching it over stdio: initialize handshake, protocol version, server info, tools/list quality (names, descriptions, inputSchema validity, undescribed parameters), response times, and error handling on a deliberately bad tool call. Returns a scored report (0-100) with named, evidence-backed issues.",
  {
    command: z.string().describe("Server launch command, e.g. npx or node"),
    args: z.array(z.string()).optional().describe("Command arguments, e.g. [\"-y\", \"@reneturcios/shipcheck\", \"mcp\"]"),
    env: z.record(z.string()).optional().describe("Extra environment variables for the server process"),
    timeoutMs: z.number().optional().describe("Per-step timeout in milliseconds, default 60000"),
  },
  async ({ command, args, env, timeoutMs }) => {
    const target = targetFromCommand([command, ...(args ?? [])]);
    if (env) target.env = env;
    const probe = await probeServer(target, { timeoutMs });
    const report = analyzeProbe(target.label, probe);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "audit_config",
  "Audit every server in an MCP client config file (Claude/Cursor style: {\"mcpServers\": {name: {command, args}}}) or a single named entry. Each server is launched and audited like audit_server. Returns one scored report per server.",
  {
    path: z.string().describe("Path to the config JSON file, on the machine running this server"),
    server: z.string().optional().describe("Only audit this named entry"),
    timeoutMs: z.number().optional().describe("Per-step timeout in milliseconds, default 60000"),
  },
  async ({ path, server: only, timeoutMs }) => {
    const text = await readFile(path, "utf8");
    const targets = parseConfig(text, only);
    const reports = [];
    for (const t of targets) {
      const probe = await probeServer(t, { timeoutMs });
      reports.push(analyzeProbe(t.label, probe));
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(reports, null, 2) }] };
  },
);

server.tool(
  "audit_tools",
  "Offline audit of a tools/list array (no server launched): validates tool names, descriptions, inputSchema shape, required-vs-properties consistency, and duplicate names. Returns a scored report.",
  {
    tools: z.array(z.record(z.unknown())).describe("The tools array exactly as a server returned it from tools/list"),
    label: z.string().optional().describe("Label for the report target"),
  },
  async ({ tools, label }) => {
    const report = auditToolsDump(label ?? "tools dump", tools as RawTool[]);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
