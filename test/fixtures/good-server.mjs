// Fixture: a well-behaved MCP server speaking raw JSON-RPC over stdio.
// No dependencies, so tests never flake on installs.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo_message",
    description: "Echo a message back to the caller. Use when you need to verify the channel works end to end.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo back." },
      },
      required: ["message"],
    },
  },
  {
    name: "server_status",
    description: "Report this fixture server's health and uptime so callers can confirm it is alive.",
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
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-good", version: "1.2.3" },
      },
    });
  } else if (msg.method === "ping") {
    reply({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "tools/list") {
    reply({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const found = tools.find((t) => t.name === name);
    if (!found) {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
    } else {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
  } else if (msg.id !== undefined) {
    reply({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
});
