/**
 * mcpaudit probe: actually talk to an MCP server over stdio.
 *
 * Uses the official SDK client: spawn the server, initialize handshake,
 * tools/list, then one deliberately bad tools/call for a tool name that
 * does not exist. Every step is timed and every failure is captured as
 * data (never thrown past this layer) so the pure analyzer can score it.
 *
 * Server name/version and capabilities come from the SDK client's
 * getters. The negotiated protocolVersion is read off the client after
 * connect (stable across SDK 1.x); when it is not exposed, the analyzer
 * reports the protocol-version-missing finding honestly rather than
 * guessing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { VERSION } from "./audit.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { AuditOptions, ProbeResult, RawTool, ServerTarget } from "./types.js";

/**
 * Transport wrapper that captures the negotiated protocolVersion (the SDK
 * hands it to transport.setProtocolVersion during connect) and taps the
 * initialize result as a fallback, without changing client behavior.
 */
class TapTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private _onmessage?: (message: JSONRPCMessage) => void;
  protocolVersion?: string;
  constructor(private inner: StdioClientTransport) {}
  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this._onmessage = handler;
    this.inner.onmessage = (message) => {
      const m = message as { result?: { protocolVersion?: unknown } };
      if (typeof m.result?.protocolVersion === "string") {
        this.protocolVersion = m.result.protocolVersion;
      }
      handler?.(message);
    };
  }
  get onmessage() {
    return this._onmessage;
  }
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    (this.inner as Transport).setProtocolVersion?.(version);
  }
  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e) => this.onerror?.(e);
    await this.inner.start();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    await this.inner.send(message);
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

const BAD_TOOL_NAME = "mcpaudit_nonexistent_tool_zz9";

/**
 * Default per-step timeout. Production validation (P-004) measured real
 * launcher startup (npx/uvx cold starts) at 25-40s for healthy servers —
 * the previous 15s default reported the whole uvx ecosystem UNREACHABLE.
 */
export const DEFAULT_TIMEOUT_MS = 60000;

export function remoteUnsupportedError(url: string): string {
  return `Remote MCP servers are not supported by this mcpaudit build: it audits stdio servers only. "${url}" is an HTTP endpoint, not a launch command — audit the server's stdio launch command (command + args) instead.`;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeServer(target: ServerTarget, opts: AuditOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result: ProbeResult = {
    connected: false,
    toolsListed: false,
    tools: [],
    badCallOutcome: "skipped",
  };

  const remoteUrl = target.remoteUrl ?? (/^https?:\/\//i.test(target.command) ? target.command : undefined);
  if (remoteUrl) {
    result.connectError = remoteUnsupportedError(remoteUrl);
    return result;
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  if (target.env) Object.assign(env, target.env);

  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    env,
    cwd: target.cwd,
    stderr: "pipe",
  });
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBuf.length < 2000) stderrBuf += chunk.toString("utf8");
  });

  const tap = new TapTransport(transport);
  const client = new Client({ name: "mcpaudit", version: VERSION }, { capabilities: {} });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch {
      /* already dead */
    }
  };

  // Initialize handshake (connect sends initialize + notifications/initialized).
  const t0 = Date.now();
  try {
    await withTimeout(client.connect(tap), timeoutMs, "initialize handshake");
  } catch (e) {
    result.connectError = stderrBuf.trim()
      ? `${errText(e)} | server stderr: ${stderrBuf.trim().slice(0, 300)}`
      : errText(e);
    await close();
    return result;
  }
  result.connected = true;
  result.initializeMs = Date.now() - t0;

    const serverVersion = client.getServerVersion();
  // Empty strings are normalized away: a server that reports version ""
  // has not told us its version, and the analyzer should say so.
  result.serverName = serverVersion?.name?.trim() || undefined;
  result.serverVersion = serverVersion?.version?.trim() || undefined;
  const caps = client.getServerCapabilities();
  result.toolsCapability = caps ? caps.tools !== undefined : undefined;
  if (tap.protocolVersion) result.protocolVersion = tap.protocolVersion;

  // tools/list. First the strict typed call every SDK client makes; if the
  // server's list fails schema validation there, fall back to a permissive
  // raw request so the analyzer can name the individual bad tools instead
  // of losing the whole list.
  const t1 = Date.now();
  try {
    const listed = await withTimeout(client.listTools(), timeoutMs, "tools/list");
    result.toolsListed = true;
    result.toolsListMs = Date.now() - t1;
    result.tools = (listed.tools ?? []) as RawTool[];
  } catch (strictErr) {
    try {
      const raw = await withTimeout(
        client.request(
          { method: "tools/list", params: {} },
          z.object({ tools: z.array(z.unknown()) }).passthrough(),
        ),
        timeoutMs,
        "tools/list (raw)",
      );
      result.toolsListed = true;
      result.toolsListMs = Date.now() - t1;
      result.tools = (raw.tools ?? []) as RawTool[];
      result.strictListError = errText(strictErr);
    } catch (e) {
      result.toolsListError = errText(e);
      await close();
      return result;
    }
  }

  // Prompts/resources surface: a server is allowed to be a prompt or
  // resource server with no tools at all — the analyzer needs the real
  // counts to tell "no tools, by design" from "no surface at all".
  // Only ask when the server advertised the capability; count the first
  // page (enough to establish the surface exists).
  const listCount = async (method: "prompts/list" | "resources/list", key: "prompts" | "resources"): Promise<number | undefined> => {
    try {
      const raw = await withTimeout(
        client.request(
          { method, params: {} },
          z.object({ [key]: z.array(z.unknown()) }).passthrough(),
        ),
        Math.min(timeoutMs, 10000),
        method,
      );
      const arr = (raw as Record<string, unknown>)[key];
      return Array.isArray(arr) ? arr.length : undefined;
    } catch {
      return undefined;
    }
  };
  if (caps?.prompts !== undefined) result.promptsCount = await listCount("prompts/list", "prompts");
  if (caps?.resources !== undefined) result.resourcesCount = await listCount("resources/list", "resources");

  // Deliberately bad call: a tool name that cannot exist.
  try {
    const bad = await withTimeout(
      client.callTool({ name: BAD_TOOL_NAME, arguments: {} }),
      timeoutMs,
      "bad tool call",
    );
    // Some servers return an isError tool result instead of a JSON-RPC
    // error. isError=true is still an error response — good handling.
    // Only a success-shaped result counts as "accepted".
    const isError = (bad as { isError?: boolean }).isError === true;
    if (isError) {
      result.badCallOutcome = "error";
      result.badCallDetail = "server returned an isError tool result for a nonexistent tool";
    } else {
      result.badCallOutcome = "success";
      result.badCallDetail = JSON.stringify(bad).slice(0, 200);
    }
  } catch (e) {
    const msg = errText(e);
    if (/timed out/i.test(msg)) {
      result.badCallOutcome = "timeout";
      result.badCallDetail = msg;
    } else {
      result.badCallOutcome = "error";
      result.badCallDetail = msg.slice(0, 200);
    }
  }

  // Liveness after the bad call: if a proper error came back but the
  // process died anyway, that is a crash, not error handling.
  if (result.badCallOutcome === "error") {
    try {
      await withTimeout(client.ping(), Math.min(timeoutMs, 5000), "post-bad-call ping");
    } catch (e) {
      const msg = errText(e);
      // A server that does not implement ping answers with an error and
      // stays alive; only a closed/dead transport counts as a crash.
      if (/closed|not connected|exited|ECONNRESET|EPIPE/i.test(msg)) {
        result.badCallOutcome = "crash";
        result.badCallDetail = `connection died after bad call: ${msg.slice(0, 160)}`;
      }
    }
  }

  await close();
  return result;
}
