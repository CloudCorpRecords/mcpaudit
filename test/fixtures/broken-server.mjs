// Fixture: a sloppy MCP server. No tools capability advertised, an empty
// server version, undescribed tools, a missing schema, a duplicate name,
// a required field that does not exist — and it accepts ANY tool call,
// including names that do not exist. mcpaudit should score it FAIL.
// (Server version is "" rather than absent because strict SDK clients
// refuse the handshake entirely when it is absent — that case, like an
// unsupported protocol version, lands on the UNREACHABLE path instead.)
import { createInterface } from "node:readline";

const tools = [
  { name: "do_thing", inputSchema: { type: "object", properties: {} } },
  { name: "x", description: "x", inputSchema: { type: "object", properties: {} } },
  { name: "no_schema", description: "A tool with a perfectly fine description but no schema at all." },
  {
    name: "mystery",
    description: "A tool whose required field is not among its properties.",
    inputSchema: {
      type: "object",
      properties: { known: { type: "string" } },
      required: ["missing_field"],
    },
  },
  {
    name: "do_thing",
    description: "Duplicate of the first tool name, described this time.",
    inputSchema: { type: "object", properties: {} },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  if (msg.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "fixture-broken", version: "" },
      },
    });
  } else if (msg.method === "ping") {
    reply({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "tools/list") {
    reply({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    // The sin: success for everything, real or invented.
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "sure, done" }] },
    });
  } else if (msg.id !== undefined) {
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
});
