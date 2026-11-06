// Private bounded JSON-line transport over this runtime's docker-exec stdio.
// Pi reaches it over loopback HTTP inside the network-none container; the
// relay logic itself is shared (relay-core.mjs).
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Failure,
  RELAY_PATHS,
  TEXT_LIMIT,
  UPLOAD_LIMIT,
  failureReply,
  forward,
  provision,
  relayLink,
} from "./relay-core.mjs";
// Container defaults: HOME=/home/node, /tmp, port 4318. The host never passes
// environment to docker exec; overrides exist only for host-side tests.
const agentDir = join(homedir(), ".pi/agent");
const port = /^[1-9][0-9]{3,4}$/.test(process.env.KATAFIT_RELAY_PORT ?? "")
  ? Number(process.env.KATAFIT_RELAY_PORT)
  : 4318;
const fatal = () => process.exit(1);
const link = relayLink({
  write: (frame) => process.stdout.write(frame),
  pressure: () => process.stdout.writableLength,
  fatal,
});
process.stdin.on("data", link.data);
process.stdin.on("end", () => process.exit(0));
const config = await link.send({ kind: "catalog" });
const fail = (res, error) => {
  const [status, headers, body] = failureReply(error);
  res.writeHead(status, headers);
  res.end(body);
};
const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || !RELAY_PATHS.includes(req.url))
      throw new Failure("NATIVE_REQUEST_REJECTED");
    const tool = req.url === "/tool";
    const limit = tool ? TEXT_LIMIT : UPLOAD_LIMIT;
    const parts = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      // Keep draining (bounded) so the client reads the fixed reply instead
      // of a reset connection; nothing over the limit is buffered.
      if (size > 2 * UPLOAD_LIMIT) req.destroy();
      else if (size <= limit) parts.push(c);
    }
    if (size > limit)
      throw new Failure(
        tool ? "NATIVE_TEXT_TOO_LARGE" : "NATIVE_WIRE_TOO_LARGE",
      );
    let body;
    try {
      body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      body = undefined;
    } finally {
      // Release the raw upload chunks before framing the parsed copy.
      parts.length = 0;
    }
    let requestId;
    res.on("close", () => {
      if (!res.writableEnded && requestId) link.cancel(requestId);
    });
    const [type, reply, completion] = await forward(
      link,
      req.url,
      body,
      (id) => (requestId = id),
    );
    res.setHeader("content-type", type);
    res.end(reply, () => {
      // This fixed relay, never a tool/model argument, acknowledges a final
      // provider reply only after its HTTP response was written to Pi.
      if (completion && !res.destroyed && requestId) link.delivered(requestId);
    });
  } catch (error) {
    fail(res, error);
  }
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));
// Host-sealed canonical seed only. No host mount and no sandbox-file upload.
// The fixed tmpfs paths are written before Pi starts and never select a host path.
provision(config, {
  agentDir,
  tmp: (process.env.TMPDIR || "/tmp").replace(/\/+$/, ""),
  baseUrl: `http://127.0.0.1:${port}/v1`,
  fatal,
});
