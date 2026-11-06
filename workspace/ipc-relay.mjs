// The workspace relay: the same relay logic as the Docker relay
// (sandbox/relay-core.mjs), over Node's IPC channel with Coach instead of
// docker-exec stdio, and answering Pi's fetch calls in-process instead of
// over loopback HTTP. Pi's process has no network permission (Node refuses
// sockets, even on inherited descriptors): the IPC channel is its only way
// out, and only Coach holds the other end. One message carries one frame.
import { homedir, tmpdir } from "node:os";
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
} from "../sandbox/relay-core.mjs";

// The address Pi's provider entry and the Kata.fit tools extension use. It is
// never dialled: fetch to this origin is answered here; anything else fails.
export const RELAY_ORIGIN = "http://127.0.0.1:4318";

/** Where the launcher leaves the relay's fetch for workspace/fetch.mjs. */
export const RELAY_FETCH = Symbol.for("katafit.workspace.relay-fetch");

const reply = (status, headers, body) =>
  new Response(body, { status, headers });

/** Connects to the host, provisions Pi's config, and returns the catalog. */
export async function connectRelay() {
  if (typeof process.send !== "function") throw new Error("RELAY_UNAVAILABLE");
  const fatal = () => process.exit(1);
  let queued = 0;
  const link = relayLink({
    write: (frame) => {
      queued += frame.length;
      process.send(frame, (error) => {
        queued -= frame.length;
        if (error) fatal();
      });
    },
    pressure: () => queued,
    fatal,
  });
  process.on("message", (frame) =>
    typeof frame === "string" ? link.data(Buffer.from(frame)) : fatal(),
  );
  process.on("disconnect", () => process.exit(0));

  // Pi installs its own fetch at startup, after this module runs, so the
  // relay's fetch is installed by an extension (workspace/fetch.mjs).
  globalThis[RELAY_FETCH] = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== RELAY_ORIGIN) throw new TypeError("fetch failed");
    try {
      if (request.method !== "POST" || !RELAY_PATHS.includes(url.pathname))
        throw new Failure("NATIVE_REQUEST_REJECTED");
      const tool = url.pathname === "/tool";
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length > (tool ? TEXT_LIMIT : UPLOAD_LIMIT))
        throw new Failure(
          tool ? "NATIVE_TEXT_TOO_LARGE" : "NATIVE_WIRE_TOO_LARGE",
        );
      let body;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {}
      let requestId;
      const cancel = () => requestId && link.cancel(requestId);
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        const [type, text, completion] = await forward(
          link,
          url.pathname,
          body,
          (id) => (requestId = id),
        );
        // Handing the reply to Pi is this transport's delivery.
        if (completion && !request.signal.aborted) link.delivered(requestId);
        return reply(200, { "content-type": type }, text);
      } finally {
        request.signal.removeEventListener("abort", cancel);
      }
    } catch (error) {
      return reply(...failureReply(error));
    }
  };

  const config = await link.send({ kind: "catalog" });
  provision(config, {
    agentDir: join(homedir(), ".pi/agent"),
    tmp: tmpdir(),
    baseUrl: `${RELAY_ORIGIN}/v1`,
    fatal,
  });
  return config;
}
