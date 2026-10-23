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
  parseCommandLine,
  parseConfig,
  renderReport,
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
  mcpaudit --version`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Everything after `audit` that is not one of our flags is the server command. */
function commandArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a === "--config" || a === "--server" || a === "--timeout" || a === "--cmdline") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

function emit(report: AuditReport, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
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
      const timeoutRaw = flag(rest, "--timeout");
      const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutRaw && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
        console.error(`error: --timeout must be a positive number of milliseconds`);
        process.exit(2);
      }
      const asJson = has(rest, "--json");
      const configPath = flag(rest, "--config");
      const cmdline = flag(rest, "--cmdline");
      let targets: ServerTarget[];
      if (configPath) {
        const text = await readFile(configPath, "utf8");
        targets = parseConfig(text, flag(rest, "--server"));
      } else if (cmdline) {
        targets = [targetFromCommand(parseCommandLine(cmdline))];
      } else {
        const argv = commandArgs(rest);
        if (argv.length === 0) usage();
        targets = [targetFromCommand(argv)];
      }
      let worst = 0;
      for (const t of targets) {
        const report = await auditTarget(t, timeoutMs);
        emit(report, asJson);
        if (report.verdict === "FAIL" || report.verdict === "UNREACHABLE") worst = 1;
      }
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
