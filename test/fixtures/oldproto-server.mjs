// Fixture: a server that answers initialize with a protocol version no
// current client supports. Strict SDK clients refuse the handshake, so
// mcpaudit must report UNREACHABLE with that reason as evidence.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "1999-01-01",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-oldproto", version: "0.0.1" },
        },
      }) + "\n",
    );
  }
});
