// The relay's sandbox side, shared by every transport: the Docker relay
// (relay.mjs: HTTP for Pi, docker-exec stdio to the host) and the workspace
// relay (workspace/ipc-relay.mjs: in-process fetch for Pi, Node IPC to the
// host). Everything here runs inside the sandbox and is untrusted; the
// host validates every frame (src/sandbox/relayChannel.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Directional limits, mirrored by the host (src/sandbox/failures.ts). Tool
// arguments stay within 1 MiB. Provider bodies are raw Pi history (every
// earlier photo is resent each turn) and are forwarded losslessly: the relay
// never inspects, drops or compacts images. The host alone validates the
// original envelope, charges its non-image bytes, compacts and caps the wire.
export const TEXT_LIMIT = 1024 * 1024;
// Keep parsing/framing headroom inside the 512 MiB Pi+relay sandbox.
export const UPLOAD_LIMIT = 32 * 1024 * 1024;
export const REQUEST_FRAME_LIMIT = UPLOAD_LIMIT + 65536;
export const RESPONSE_FRAME_LIMIT = 16 * 1024 * 1024;
// Fixed allowlisted failures: [HTTP status, actionable message]. Only these
// texts reach Pi. Non-transient local failures use 4xx statuses and wording
// that Pi's automatic retry does not match; see tests/native-image-gateway.
export const failures = {
  NATIVE_TEXT_TOO_LARGE: [
    413,
    "Conversation text, tool schemas and metadata (including metadata on older photos) are over the native 1 MiB text budget; only validated photo data is counted separately. Nothing was sent to the provider. /compact may need this same oversized request, so start a new Pi session and ask a focused question.",
  ],
  NATIVE_IMAGE_REJECTED: [
    422,
    "An image failed native validation (PNG, JPEG, WebP or GIF; canonical base64; a header matching the declared type; at most 8 MiB each). Nothing was sent to the provider. Read the photo again with the authorized Kata.fit image tool.",
  ],
  NATIVE_WIRE_TOO_LARGE: [
    413,
    "The request exceeds the native 32 MiB history/transport budget. Nothing was sent to the provider. /compact may need this same oversized request, so start a new Pi session and ask a focused question with fewer or smaller photos.",
  ],
  NATIVE_RESULT_TOO_LARGE: [
    413,
    "The result was over the native 16 MiB return budget and was withheld. If this was an action, its outcome is unknown; do not replay it.",
  ],
  NATIVE_REQUEST_BUSY: [
    409,
    "Another native request is still pending. This request was not dispatched and consumed nothing. Wait for the pending request to finish, then send again.",
  ],
  NATIVE_REQUEST_REJECTED: [
    400,
    "The native request shape was rejected and not dispatched.",
  ],
  NATIVE_MODEL_REJECTED: [
    400,
    "The request did not target the Coach-configured model. Nothing was dispatched; use the katafit model selected by Coach.",
  ],
  NATIVE_CREDENTIAL_BLOCKED: [
    400,
    "A saved credential appeared in the outbound request. Nothing was sent to the provider; remove credentials from the conversation.",
  ],
  NATIVE_SESSION_EXPIRED: [
    410,
    "This native Coach session has expired and is closing. Its context cannot continue; open a new native session from Coach.",
  ],
  NATIVE_SESSION_REVOKED: [
    403,
    "This native Coach session is no longer authorized (configuration, credentials or Kata.fit authority changed) and is closing. Open a new native session from Coach; earlier context is not carried over.",
  ],
  NATIVE_CANCELLED: [499, "The request was cancelled."],
  NATIVE_DELIVERY_UNVERIFIED: [
    409,
    "A previous message delivery is still unverified. Nothing was sent to the provider. Check the canonical Kata.fit conversation; do not resend that message.",
  ],
  NATIVE_TURN_UNRESOLVED: [
    409,
    "The new turn could not be confirmed with Kata.fit yet. Nothing was sent to the provider; send again shortly and the same pending turn is resumed, never duplicated.",
  ],
  NATIVE_TURN_REQUIRED: [
    409,
    "This turn's Kata.fit authorization expired; only a new human message renews it. Nothing was sent to the provider, or its reply was withheld. Send a new message to continue; do not replay earlier actions.",
  ],
  NATIVE_AUTHORIZATION_FAILED: [
    424,
    "Kata.fit could not re-authorize the evidence for this turn, so the request was not sent or its reply was withheld. Check the Kata.fit connection, then ask again.",
  ],
  NATIVE_PROVIDER_AUTH_FAILED: [
    401,
    "The provider rejected the saved API key or model permissions. Update the provider key in Coach settings.",
  ],
  NATIVE_PROVIDER_RATE_LIMITED: [
    429,
    "The provider rate limit was reached. Wait before asking again.",
  ],
  NATIVE_PROVIDER_QUOTA_EXCEEDED: [
    429,
    "Provider quota exceeded: credits or billing limits are exhausted. Check the provider account before asking again.",
  ],
  NATIVE_PROVIDER_TIMEOUT: [
    504,
    "The provider did not answer within the inference time budget (timeout). Ask again or reduce the request.",
  ],
  NATIVE_PROVIDER_UNAVAILABLE: [
    503,
    "The provider reported a server-side failure. Check its status and ask again later.",
  ],
  NATIVE_PROVIDER_PAYLOAD_TOO_LARGE: [
    413,
    "The provider rejected the multimodal request size. Start a new Pi session and ask a focused question with fewer or smaller photos; the model context window setting will not fix this.",
  ],
  NATIVE_PROVIDER_CONTEXT_LIMIT: [
    400,
    "The provider rejected the conversation as larger than the model context window. /compact may hit the same limit; start a new Pi session and ask a focused question.",
  ],
  NATIVE_PROVIDER_REQUEST_REJECTED: [
    400,
    "The provider rejected the request. Check the model, endpoint and image support in Coach settings.",
  ],
  NATIVE_PROVIDER_NETWORK_FAILED: [
    502,
    "The provider connection failed (network error) before a complete reply. Check the provider endpoint and network, then ask again.",
  ],
  NATIVE_PROVIDER_OUTPUT_REJECTED: [
    502,
    "The provider reply failed native size or credential screening and was withheld. Ask again, requesting a shorter answer.",
  ],
  NATIVE_TOOL_FAILED: [
    502,
    "Kata.fit tool failed; do not replay uncertain actions.",
  ],
  NATIVE_REST_TIMEOUT: [
    504,
    "The Kata.fit read took longer than 8 seconds and was abandoned.",
  ],
  NATIVE_REST_TOO_LARGE: [
    413,
    "The Kata.fit read returned more than 256 KiB of JSON and was withheld.",
  ],
  NATIVE_REST_UNAVAILABLE: [
    502,
    "The Kata.fit read could not be completed (connection, redirect or non-JSON response).",
  ],
  NATIVE_REST_REJECTED: [
    422,
    "The Kata.fit backend rejected this write; it was not applied.",
  ],
  NATIVE_GATEWAY_TIMEOUT: [
    504,
    "Coach did not answer this native request in time (timeout); its outcome is unknown. Check Coach state before repeating any action.",
  ],

  NATIVE_GATEWAY_FAILED: [
    500,
    "The native request failed for an unclassified reason; details are withheld. Check Coach diagnostics and do not repeat actions whose outcome is unknown.",
  ],
};
export class Failure extends Error {
  constructor(code, status) {
    super(code);
    this.code = Object.hasOwn(failures, code) ? code : "NATIVE_GATEWAY_FAILED";
    // Upstream provider status: an integer only, never upstream text.
    this.status =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
  }
}

/**
 * Bounded JSON-line link to the host. `write` sends one frame; `pressure`
 * reports bytes still queued for the host. Protocol violations are fatal.
 */
export function relayLink({ write, pressure, fatal }) {
  let id = 0;
  const pending = new Map();
  // Ids this relay gave up on; a late host reply is dropped, not fatal.
  const abandoned = new Set();
  const send = (request, onId) =>
    new Promise((resolve, reject) => {
      // Abandoned ids may still be pending host-side; they count too.
      if (pending.size + abandoned.size >= 4)
        return reject(new Failure("NATIVE_REQUEST_BUSY"));
      const key = ++id;
      const frame = JSON.stringify({ id: key, request }) + "\n";
      if (Buffer.byteLength(frame) > REQUEST_FRAME_LIMIT)
        return reject(new Failure("NATIVE_WIRE_TOO_LARGE"));
      if (pressure() > REQUEST_FRAME_LIMIT)
        return reject(new Failure("NATIVE_REQUEST_BUSY"));
      onId?.(key);
      const timer = setTimeout(() => {
        pending.delete(key);
        abandoned.add(key);
        write(JSON.stringify({ cancel: key }) + "\n");
        reject(new Failure("NATIVE_GATEWAY_TIMEOUT"));
      }, 125000);
      pending.set(key, { resolve, reject, timer });
      write(frame);
    });
  // Byte-counted line framing over raw chunks (linear in frame size).
  let chunks = [];
  let buffered = 0;
  const receive = (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      fatal();
      return;
    }
    if (abandoned.delete(frame?.id)) return;
    const entry = pending.get(frame?.id);
    if (!entry) {
      fatal();
      return;
    }
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    frame.error
      ? entry.reject(new Failure(frame.error, frame.status))
      : entry.resolve(frame.result);
  };
  const data = (chunk) => {
    let start = 0,
      end;
    while ((end = chunk.indexOf(10, start)) >= 0) {
      if (buffered + end - start > RESPONSE_FRAME_LIMIT + 65536) return fatal();
      chunks.push(chunk.subarray(start, end));
      const line = Buffer.concat(chunks).toString("utf8");
      chunks = [];
      buffered = 0;
      start = end + 1;
      receive(line);
    }
    if (start < chunk.length) {
      buffered += chunk.length - start;
      if (buffered > RESPONSE_FRAME_LIMIT + 65536) return fatal();
      chunks.push(chunk.subarray(start));
    }
  };
  const cancel = (key) => write(JSON.stringify({ cancel: key }) + "\n");
  const delivered = (key) => write(JSON.stringify({ delivered: key }) + "\n");
  return { send, data, cancel, delivered };
}

/**
 * Applies the host-sealed catalog: canonical history seed, skills, Pi's
 * provider entry and the launcher's config. Paths are fixed by the transport,
 * never chosen by the host.
 */
export function provision(config, { agentDir, tmp, baseUrl, fatal }) {
  if (config.history) {
    const entries = config.history.entries;
    if (
      !Array.isArray(entries) ||
      !entries.length ||
      entries.length > 10000 ||
      entries[0]?.type !== "session" ||
      entries[0]?.version !== 3
    )
      return fatal();
    const history =
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    if (Buffer.byteLength(history) > 2 * 1024 * 1024) return fatal();
    writeFileSync(tmp + "/native-history.jsonl", history, {
      mode: 0o600,
      flag: "wx",
    });
  }
  for (const skill of config.skills ?? []) {
    if (
      !skill ||
      typeof skill !== "object" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(skill.id) ||
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      !skill.description.trim() ||
      skill.description.length > 1024 ||
      typeof skill.body !== "string" ||
      !skill.body.trim() ||
      Buffer.byteLength(skill.body) > 65536
    )
      return fatal();
    const directory = join(agentDir, "skills", skill.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      directory + "/SKILL.md",
      `---\nname: ${skill.id}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        katafit: {
          baseUrl,
          api: "openai-completions",
          apiKey: "runtime-only",
          models: [
            {
              id: config.model,
              name: config.model,
              reasoning: false,
              input: config.vision ? ["text", "image"] : ["text"],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(tmp + "/native-config.json", JSON.stringify(config));
}

/** The fixed reply Pi sees for a failure: [status, headers, JSON body]. */
export function failureReply(error) {
  const code = error instanceof Failure ? error.code : "NATIVE_GATEWAY_FAILED";
  const [fixed, text] = failures[code];
  const status =
    code === "NATIVE_PROVIDER_AUTH_FAILED" && [401, 403].includes(error.status)
      ? error.status
      : fixed;
  return [
    status,
    {
      "content-type": "application/json",
      // Retry decisions belong to Pi's visible policy, not hidden SDK retries.
      "x-should-retry": "false",
    },
    JSON.stringify({
      error: {
        message:
          `${code}: ${text}` +
          (error.status
            ? code.startsWith("NATIVE_REST_")
              ? ` (HTTP ${error.status})`
              : ` (provider HTTP ${error.status})`
            : ""),
        type: "native_gateway",
        code,
        ...(error.status ? { status: error.status } : {}),
      },
    }),
  ];
}

/** Pi's two relay endpoints; anything else is rejected before dispatch. */
export const RELAY_PATHS = ["/tool", "/v1/chat/completions"];

/**
 * One parsed Pi request (body already bounded by the transport) to the host.
 * Resolves [contentType, body, completionId?] for a successful reply.
 */
export async function forward(link, path, body, onId) {
  if (body === undefined) throw new Failure("NATIVE_REQUEST_REJECTED");
  const tool = path === "/tool";
  const result = await link.send(
    tool
      ? {
          kind: "tool",
          name: body?.name,
          args: body?.args,
          toolCallId: body?.toolCallId,
        }
      : { kind: "provider", body },
    onId,
  );
  return tool
    ? ["application/json", JSON.stringify(result), undefined]
    : [result.type, result.body, result.completion_id];
}
