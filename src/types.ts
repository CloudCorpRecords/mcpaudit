/**
 * mcpaudit types.
 *
 * An AuditReport is the result of probing one MCP server: the initialize
 * handshake, the tools/list response, every tool's name / description /
 * inputSchema, and how the server reacts to a deliberately bad tool call.
 * Every Issue carries the evidence for its verdict — the actual value that
 * was found — never an inferred or invented claim.
 */

export type Severity = "error" | "warning" | "info";

export interface AuditIssue {
  /** Stable code, e.g. "DESC_MISSING", "BAD_CALL_ACCEPTED". */
  code: string;
  severity: Severity;
  /** Tool name the issue belongs to, when it is tool-specific. */
  tool?: string;
  detail: string;
  /** The actual value observed, when there is one worth quoting. */
  evidence?: string;
}

export type Verdict = "PASS" | "WARN" | "FAIL" | "UNREACHABLE";

/** A tool exactly as the server reported it in tools/list (fields optional on the wire). */
export interface RawTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** What the probe layer measured by actually talking to a server. */
export interface ProbeResult {
  /** The initialize handshake completed and returned a result. */
  connected: boolean;
  /** Why the probe failed, when connected is false. */
  connectError?: string;
  /** Milliseconds from spawn to initialize response. */
  initializeMs?: number;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  /** Server advertised a tools capability in initialize. */
  toolsCapability?: boolean;
  /** tools/list completed. */
  toolsListed: boolean;
  toolsListError?: string;
  /**
   * The strict (SDK-typed) tools/list failed validation but a permissive
   * raw request succeeded. Evidence that strict clients cannot consume
   * this server's tool list even though lenient ones can.
   */
  strictListError?: string;
  /** Milliseconds for tools/list. */
  toolsListMs?: number;
  tools: RawTool[];
  /** prompts/list count, when the server advertised a prompts capability and answered. */
  promptsCount?: number;
  /** resources/list count, when the server advertised a resources capability and answered. */
  resourcesCount?: number;
  /**
   * Result of calling a tool name that does not exist:
   * "error"   = server returned a JSON-RPC error and stayed alive (correct),
   * "success" = server reported success for a nonexistent tool,
   * "crash"   = the connection died / process exited,
   * "timeout" = no response inside the probe window,
   * "skipped" = not attempted (server never connected / no tools listed).
   */
  badCallOutcome: "error" | "success" | "crash" | "timeout" | "skipped";
  badCallDetail?: string;
}

export interface AuditReport {
  /** Human label for the target: the command line or config entry name. */
  target: string;
  verdict: Verdict;
  /** 0-100. UNREACHABLE is always 0. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  issues: AuditIssue[];
  summary: {
    connected: boolean;
    protocolVersion?: string;
    serverName?: string;
    serverVersion?: string;
    toolCount: number;
    promptsCount?: number;
    resourcesCount?: number;
    initializeMs?: number;
    toolsListMs?: number;
    badCallOutcome: ProbeResult["badCallOutcome"];
    errors: number;
    warnings: number;
  };
  checkedAt: string;
}

/** One server entry resolved from a client config file or the CLI. */
export interface ServerTarget {
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Set when the target is a remote (HTTP) MCP endpoint rather than a stdio command. */
  remoteUrl?: string;
}

export interface AuditOptions {
  /** Per-request timeout for initialize / tools/list / bad call. Default 60000. */
  timeoutMs?: number;
}
