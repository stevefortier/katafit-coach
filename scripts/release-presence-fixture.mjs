import { createServer } from "node:http";

// The generation CAS mirrors tests/presence.test.ts. This is a synthetic MCP
// service; only real worker RPCs can change its presence ledger.
export function releasePresenceFixture({ fault } = {}) {
  if (fault && !["unsupported", "wrong-generation"].includes(fault))
    throw Error("INVALID_PRESENCE_FIXTURE_FAULT");
  const generations = new Map(),
    stopped = new Map(),
    seen = new Set();
  const reports = [];
  let sequence = 0,
    rejectedIdentity = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-release-token") {
      rejectedIdentity++;
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (msg.method === "tools/list")
      result = {
        tools:
          fault === "unsupported"
            ? []
            : [{ name: "coach_report_worker_presence" }],
      };
    else if (
      msg.method === "tools/call" &&
      msg.params?.name === "coach_report_worker_presence"
    ) {
      const args = msg.params.arguments ?? {};
      const current = generations.get(args.instance_id);
      const keys = Object.keys(args).sort().join(",");
      const valid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          args.instance_id ?? "",
        ) &&
        ["instance_id,state", "generation,instance_id,state"].includes(keys) &&
        (args.state === "running"
          ? current === undefined
            ? !seen.has(args.instance_id) && args.generation === undefined
            : args.generation === current
          : args.state === "stopped" &&
            typeof args.generation === "string" &&
            (current !== undefined
              ? args.generation === current
              : stopped.get(args.instance_id) === args.generation));
      let generation;
      if (valid && args.state === "running") {
        seen.add(args.instance_id);
        generation = (++sequence).toString(16).padStart(32, "0");
        generations.set(args.instance_id, generation);
      } else if (valid) {
        stopped.set(args.instance_id, args.generation);
        generations.delete(args.instance_id);
      }
      // Valid-shaped but wrong response generation: the next real heartbeat or
      // Stop must be rejected by CAS, never silently accepted as reported Stop.
      const returnedGeneration =
        fault === "wrong-generation" && generation
          ? "f".repeat(32)
          : generation;
      reports.push({
        ...args,
        accepted: valid,
        issuedGeneration: generation,
        returnedGeneration,
      });
      result = valid
        ? {
            structuredContent: {
              ok: true,
              state: args.state,
              ...(returnedGeneration ? { generation: returnedGeneration } : {}),
            },
          }
        : {
            isError: true,
            structuredContent: { code: "WORKER_PRESENCE_STALE" },
          };
    } else result = { structuredContent: { requests: [] } };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  return {
    server,
    snapshot: () => ({
      fault: fault ?? null,
      rejectedIdentity,
      reports: structuredClone(reports),
      running: [...generations.keys()],
      stopped: [...stopped.keys()],
    }),
  };
}
