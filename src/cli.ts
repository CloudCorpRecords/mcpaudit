#!/usr/bin/env node
/**
 * mcpaudit CLI.
 *
 *   mcpaudit audit <command...> [--timeout ms] [--json]
 *   mcpaudit audit --config <file> [--server <name>] [--timeout ms] [--json]
 *   mcpaudit audit --cmdline "npx -y @scope/pkg mcp" [--json]
 *   mcpaudit tools <tools.json> [--json]     offline: audit a tools/list dump
 *   mcpaudit mcp
 *
 * Exit codes: 0 PASS/WARN, 1 FAIL/UNREACHABLE, 2 usage or setup error.
 */
import { readFile } from "node:fs/promises";
import {
  analyzeProbe,
  auditToolsDump,
  extractServerCommand,
  formatReports,
  parseCommandLine,
  parseConfig,
  targetFromCommand,
  VERSION,
} from "./audit.js";
import { probeServer } from "./probe.js";
import type { AuditReport, RawTool, ServerTarget } from "./types.js";

function usage(): never {
  console.error(`Usage:
  mcpaudit audit <command...> [--timeout ms] [--json]
  mcpaudit audit --config <file> [--server <name>] [--timeout ms] [--json]
  mcpaudit audit --cmdline "<command line>" [--json]
  mcpaudit tools <tools.json> [--json]
  mcpaudit mcp
  mcpaudit --version

Server arguments pass through verbatim, including arguments that start
with -- (for example: mcpaudit audit uvx mcp-server-git --repository /path).
Use a literal -- to force everything after it into the server command:
  mcpaudit audit node server.js -- --timeout 5000
mcpaudit audits stdio servers; remote (HTTP) endpoints are reported as
unsupported rather than launched.`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function emit(report: AuditReport, asJson: boolean): void {
  console.log(formatReports([report], asJson));
}

async function auditTarget(target: ServerTarget, timeoutMs?: number): Promise<AuditReport> {
  const probe = await probeServer(target, { timeoutMs });
  return analyzeProbe(target.label, probe);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  try {
    if (cmd === "audit") {
      // mcpaudit's own flags live before a literal `--`; everything after
      // `--` belongs to the server command.
      const sep = rest.indexOf("--");
      const ownPart = sep >= 0 ? rest.slice(0, sep) : rest;
      const timeoutRaw = flag(ownPart, "--timeout");
      const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutRaw && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
        console.error(`error: --timeout must be a positive number of milliseconds`);
        process.exit(2);
      }
      const asJson = has(ownPart, "--json");
      const configPath = flag(ownPart, "--config");
      const cmdline = flag(ownPart, "--cmdline");
      let targets: ServerTarget[];
      if (configPath) {
        const text = await readFile(configPath, "utf8");
        targets = parseConfig(text, flag(ownPart, "--server"));
      } else if (cmdline) {
        targets = [targetFromCommand(parseCommandLine(cmdline))];
      } else {
        const argv = extractServerCommand(rest);
        if (argv.length === 0) usage();
        targets = [targetFromCommand(argv)];
      }
      let worst = 0;
      const reports: AuditReport[] = [];
      for (const t of targets) {
        const report = await auditTarget(t, timeoutMs);
        reports.push(report);
        if (!asJson) console.log(formatReports([report], false));
        if (report.verdict === "FAIL" || report.verdict === "UNREACHABLE") worst = 1;
      }
      // JSON mode: exactly one parseable document for the whole run
      // (an array when a config named several servers).
      if (asJson) console.log(formatReports(reports, true));
      process.exit(worst);
    } else if (cmd === "tools") {
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) usage();
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const tools: RawTool[] = Array.isArray(parsed)
        ? (parsed as RawTool[])
        : ((parsed as { tools?: RawTool[] }).tools ?? []);
      if (!Array.isArray(tools)) {
        console.error("error: expected a JSON array of tools or an object with a tools array");
        process.exit(2);
      }
      const report = auditToolsDump(file, tools);
      emit(report, has(rest, "--json"));
      process.exit(report.verdict === "FAIL" ? 1 : 0);
    } else {
      usage();
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

void main();
