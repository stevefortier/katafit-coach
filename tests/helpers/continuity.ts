import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Store } from "../../src/config/store.js";

// Synthetic loopback model of the committed backend continuity v1 contract
// (regimen-backend core/studioOperator.js b1a43933 and
// docs/studio-operator-continuity.md). Strict input keys, exact generation,
// 12 calls per generation, one send per generation, content-free host controls,
// identical-transition reconciliation. No real backend, provider or customer.
const ROSTER = "studio_operator_list_members";
const SEND = "studio_operator_send_message";
const GET = "studio_operator_get_action";
const AUTHORIZE = "studio_operator_authorize_context";
const ADVANCE = "studio_operator_advance_turn";
export const GENERIC = "studio_operator_read_synthetic_generic";
export const CHECKINS = "studio_operator_list_dojo_checkins";
export const IMAGE = "studio_operator_read_dojo_checkin_image";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const generation = {
  type: "integer",
  minimum: 0,
  maximum: 63,
  description:
    "Host-owned; required for continuity sessions, never selected by the model.",
};
const strict = (properties: Record<string, any>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const sid = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const schemas: Record<string, any> = {
  studio_operator_open_session: {
    type: "object",
    properties: {
      mode: { type: "string" },
      idempotency_key: { type: "string" },
      continuity_version: { type: "integer" },
    },
    additionalProperties: false,
  },
  studio_operator_close_session: strict({ session_id: sid }, ["session_id"]),
  [ROSTER]: strict(
    {
      session_id: sid,
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 4096 },
      turn_generation: generation,
    },
    ["session_id"],
  ),
  [SEND]: strict(
    {
      session_id: sid,
      member_ref: { type: "string", minLength: 1, maxLength: 256 },
      idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1, maxLength: 8000 },
      turn_generation: generation,
    },
    ["session_id", "idempotency_key", "text"],
  ),
  [GET]: strict(
    {
      session_id: sid,
      member_ref: { type: "string" },
      idempotency_key: { type: "string" },
    },
    ["session_id", "idempotency_key"],
  ),
  [AUTHORIZE]: strict({ session_id: sid, turn_generation: generation }, [
    "session_id",
    "turn_generation",
  ]),
  [ADVANCE]: strict(
    {
      session_id: sid,
      turn_generation: generation,
      idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
      resolved_action_id: sid,
    },
    ["session_id", "turn_generation", "idempotency_key"],
  ),
  // Deliberately permissive: reserved continuity identity must be rejected
  // by the host regardless of what a backend schema admits.
  [CHECKINS]: strict(
    {
      session_id: sid,
      limit: { type: "integer", minimum: 1, maximum: 10 },
      cursor: { type: "string", maxLength: 4096 },
      turn_generation: generation,
    },
    ["session_id"],
  ),
  [IMAGE]: strict(
    {
      session_id: sid,
      member_ref: { type: "string", minLength: 1, maxLength: 256 },
      media_ref: { type: "string", minLength: 1, maxLength: 4096 },
      turn_generation: generation,
    },
    ["session_id", "member_ref", "media_ref"],
  ),
  [GENERIC]: {
    type: "object",
    properties: {
      session_id: sid,
      topic: { type: "string", maxLength: 64 },
      turn_generation: generation,
    },
    required: ["session_id"],
    additionalProperties: true,
    patternProperties: { "^x_": { type: "string" } },
  },
};
const capability = (
  name: string,
  kind: "read" | "write",
  target: "dojo" | "member_ref",
  domain: string,
  side_effect = "none",
  receipt = "none",
) => ({
  name,
  schema_ref: `mcp:tools/list#${name}`,
  kind,
  target,
  domain,
  coverage: "synthetic_current_authority",
  pagination: { type: "none" },
  side_effect,
  receipt,
});
export function sse(delta: unknown, done: boolean) {
  return `data: ${JSON.stringify({ id: "continuity", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "continuity", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}
export const toolCall = (name: string, args: unknown, id = "call") =>
  sse(
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    false,
  );
export const answer = (content: string) => sse({ content }, true);

export interface ContinuityOptions {
  continuity?: boolean;
  commandTtlMs?: number;
  contextTtlMs?: number;
  maxTurns?: number;
  descriptor?: (d: any) => any;
  // Commit the send, then drop the HTTP response (ack lost). late_commit drops
  // it uncommitted and commits after the first not_found lookup (in-flight).
  sendAck?:
    | "delivered"
    | "lost_committed"
    | "lost_uncommitted"
    | "late_commit"
    | "late_after_advance";
  // OPERATOR_UNAVAILABLE responses before normal processing (36d4822).
  unavailable?: { authorize?: number; advance?: number; getAction?: number };
  // Commit the advance, then answer OPERATOR_UNAVAILABLE (worst case).
  unavailableAfterAdvanceCommit?: number;
  // Additive terminal marker (context_revoked:true) on definite retained
  // failures; omitted to model a backend without the marker.
  revocationMarker?: boolean;
  // The denying call cannot persist the revoked tombstone.
  tombstoneFails?: boolean;
  // Hold close_session (models slow runtime/gateway teardown).
  closeGate?: Promise<void>;
  // Negotiate check-in listing and original image reads.
  images?: boolean;
  // Runs after each successful authorize_context (1-based count).
  afterAuthorize?: (state: Backend, count: number) => void;
  // Answer a tools/call with this bare HTTP status (401/403 credential
  // rejection, 5xx outage) or drop the connection ("drop"), before any MCP
  // processing. The body carries private text the host must never surface.
  httpFailure?: (name: string, args: any) => number | "drop" | undefined;
  // Number of advance responses to drop AFTER committing.
  loseAdvanceAcks?: number;
  authorizeResponse?: (value: any) => any;
  // Returning undefined holds the response open (cancellation tests).
  provider?: (
    body: any,
    state: Backend,
    res: import("node:http").ServerResponse,
  ) => string | undefined | Promise<string | undefined>;
}
export interface Backend {
  session_id: string;
  generation: number;
  commandExpires: number;
  contextExpires: number;
  status: "active" | "closed" | "revoked";
  calls: number;
  delivered?: string;
  revoked: boolean;
  transitions: { key: string; input: string; receipt: any }[];
  actions: Map<string, any>;
  messages: { text: string; generation: number }[];
}

export async function continuityFixture(options: ContinuityOptions = {}) {
  const calls: {
    path?: string;
    name?: string;
    method?: string;
    args?: any;
    body: any;
  }[] = [];
  const now = Date.now();
  const png = options.images
    ? await (
        await import("sharp")
      )
        .default({
          create: {
            width: 3,
            height: 2,
            channels: 3,
            background: "#123456",
          },
        })
        .png()
        .toBuffer()
    : undefined;
  const state: Backend = {
    session_id: randomBytes(32).toString("hex"),
    generation: 0,
    commandExpires:
      now +
      Math.min(
        options.commandTtlMs ?? 900000,
        options.contextTtlMs ?? 28800000,
      ),
    contextExpires: now + (options.contextTtlMs ?? 28800000),
    status: "active",
    calls: 0,
    revoked: false,
    transitions: [],
    actions: new Map(),
    messages: [],
  };
  let lostAdvance = options.loseAdvanceAcks ?? 0;
  const unavailable = {
    authorize: 0,
    advance: 0,
    getAction: 0,
    ...options.unavailable,
  };
  let unavailableAfterCommit = options.unavailableAfterAdvanceCommit ?? 0;
  let lateSend: (() => void) | undefined;
  let authorizations = 0;
  let lostSend = options.sendAck && options.sendAck !== "delivered" ? 1 : 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const maxTurns = options.maxTurns ?? 64;
  const deny = (code = "OPERATOR_NOT_AUTHORIZED") => ({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code, error: "Operator command unavailable" }),
      },
    ],
  });
  // Definite retained-authority failure (backend retainedFailure()).
  const denyRetained = () =>
    options.revocationMarker
      ? {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "OPERATOR_NOT_AUTHORIZED",
                error:
                  "Operator command is unavailable or no longer authorized.",
                context_revoked: true,
              }),
            },
          ],
        }
      : deny();
  const exactKeys = (name: string, args: any) => {
    const schema = schemas[name];
    if (!schema || !args || typeof args !== "object") return false;
    if (schema.additionalProperties === false)
      for (const key of Object.keys(args))
        if (!Object.hasOwn(schema.properties, key)) return false;
    return (schema.required ?? []).every((k: string) => Object.hasOwn(args, k));
  };
  // Mirrors studioOperator.js:176-182 preconditions for continuity sessions.
  const retained = (args: any, exactGeneration: boolean) => {
    if (args.session_id !== state.session_id) return deny();
    if (
      options.continuity !== false &&
      exactGeneration &&
      args.turn_generation !== state.generation
    )
      return deny("OPERATOR_CONFLICT");
    if (state.revoked) {
      if (!options.tombstoneFails && state.status === "active")
        state.status = "revoked";
      return denyRetained();
    }
    if (state.status !== "active" || state.contextExpires <= Date.now())
      return denyRetained();
    return null;
  };
  const tool = (name: string, args: any): any => {
    if (!exactKeys(name, args)) return deny();
    if (name === "studio_operator_open_session") {
      if (options.continuity !== false && args.continuity_version !== 1)
        return deny();
      const descriptor = {
        version: 1,
        host_controls: [AUTHORIZE, ADVANCE],
        max_turns: maxTurns,
        max_tool_calls_per_turn: 12,
        command_ttl_ms: options.commandTtlMs ?? 900000,
        retained_ttl_ms: options.contextTtlMs ?? 28800000,
        failure_requires: "destroy_runtime",
        generation_field: "turn_generation",
      };
      const allowed = [
        ROSTER,
        SEND,
        GET,
        GENERIC,
        ...(options.images ? [CHECKINS, IMAGE] : []),
      ];
      return {
        schema_version: 1,
        session_id: state.session_id,
        mode: "dojo_operator",
        status: "active",
        expires_at: iso(state.commandExpires),
        allowed_tools: allowed,
        capabilities: {
          version: 1,
          tools: [
            capability(ROSTER, "read", "dojo", "roster"),
            capability(
              SEND,
              "write",
              "member_ref",
              "coach_message",
              options.continuity === false
                ? "durable_delivery_one_per_session"
                : "durable_delivery_one_per_turn_generation",
              "delivered_action_id_or_get_action_by_same_session_member_ref_idempotency_key",
            ),
            capability(
              GET,
              "read",
              "member_ref",
              "send_receipt",
              "none",
              "delivered_or_not_found",
            ),
            capability(GENERIC, "read", "dojo", "synthetic_generic"),
            ...(options.images
              ? [
                  capability(CHECKINS, "read", "dojo", "checkin_media"),
                  capability(IMAGE, "read", "member_ref", "checkin_image"),
                ]
              : []),
          ],
        },
        ...(options.continuity === false
          ? {}
          : {
              continuity: options.descriptor
                ? options.descriptor(descriptor)
                : descriptor,
              turn_generation: 0,
              context_expires_at: iso(state.contextExpires),
            }),
      };
    }
    if (name === "studio_operator_close_session") {
      if (args.session_id !== state.session_id) return deny();
      state.status = "closed";
      return {
        schema_version: 1,
        session_id: state.session_id,
        status: "closed",
      };
    }
    if (name === GET) {
      if (args.session_id !== state.session_id) return deny();
      if (unavailable.getAction > 0) {
        unavailable.getAction--;
        return deny("OPERATOR_UNAVAILABLE");
      }
      const action = state.actions.get(
        digest([args.session_id, args.idempotency_key]),
      );
      return action
        ? { ...action.receipt, idempotent: true }
        : {
            schema_version: 1,
            session_id: state.session_id,
            status: "not_found",
          };
    }
    if (name === ADVANCE) {
      const denied = retained(args, false);
      if (denied) return denied;
      if (unavailable.advance > 0) {
        unavailable.advance--;
        return deny("OPERATOR_UNAVAILABLE");
      }
      const input = digest(args);
      const previous = state.transitions.find(
        (t) => t.key === digest(args.idempotency_key),
      );
      if (previous) {
        if (
          previous.input !== input ||
          previous.receipt.turn_generation !== state.generation
        )
          return deny("OPERATOR_CONFLICT");
        return previous.receipt;
      }
      if (
        args.turn_generation !== state.generation ||
        state.generation >= maxTurns - 1 ||
        (args.resolved_action_id ?? null) !== (state.delivered ?? null)
      )
        return deny("OPERATOR_CONFLICT");
      state.commandExpires = Math.min(
        Date.now() + (options.commandTtlMs ?? 900000),
        state.contextExpires,
      );
      const receipt = {
        schema_version: 1,
        session_id: state.session_id,
        status: "advanced",
        turn_generation: state.generation + 1,
        expires_at: iso(state.commandExpires),
        context_expires_at: iso(state.contextExpires),
      };
      state.transitions.push({
        key: digest(args.idempotency_key),
        input,
        receipt,
      });
      state.generation++;
      state.calls = 0;
      state.delivered = undefined;
      if (unavailableAfterCommit > 0) {
        unavailableAfterCommit--;
        return deny("OPERATOR_UNAVAILABLE");
      }
      return receipt;
    }
    const denied = retained(args, true);
    if (denied) return denied;
    if (state.commandExpires <= Date.now()) return deny();
    if (name === AUTHORIZE) {
      if (unavailable.authorize > 0) {
        unavailable.authorize--;
        return deny("OPERATOR_UNAVAILABLE");
      }
      const value = {
        schema_version: 1,
        session_id: state.session_id,
        turn_generation: state.generation,
        status: "authorized",
        expires_at: iso(state.commandExpires),
        context_expires_at: iso(state.contextExpires),
      };
      options.afterAuthorize?.(state, ++authorizations);
      return options.authorizeResponse
        ? options.authorizeResponse(value)
        : value;
    }
    if (state.calls >= 12) return deny("READ_LIMIT");
    // Ordinary invalid model argument: a per-call denial that rolls back and
    // neither consumes budget nor revokes retained authority.
    if (name === GENERIC && args.topic === "invalid") return deny();
    // Arbitrary, non-allowlisted error payload the host must never surface.
    if (name === GENERIC && args.topic === "payload")
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "OPERATOR_NOT_AUTHORIZED",
              error: "PRIVATE MEMBER PAYLOAD",
              context_revoked: "true",
              detail: { member: "Synthetic Alice" },
            }),
          },
        ],
      };
    state.calls++;
    if (name === ROSTER)
      return {
        schema_version: 1,
        members: [
          { member_ref: "fixture-member", display_name: "Synthetic Alice" },
        ],
        has_more: false,
        next_cursor: null,
      };
    if (name === GENERIC)
      return {
        schema_version: 1,
        private_context: "SYNTHETIC GENERIC RETAINED SOURCE",
      };
    if (name === SEND) return send(args);
    if (name === CHECKINS && options.images)
      return {
        schema_version: 1,
        items: [
          {
            member_ref: "fixture-member",
            display_name: "Synthetic Alice",
            access: "shared",
            checkin_status: "completed_media",
            images: [{ media_ref: "media-1", checkin_at: iso(now) }],
          },
        ],
        has_more: false,
        next_cursor: null,
      };
    if (name === IMAGE && options.images) {
      if (args.member_ref !== "fixture-member" || args.media_ref !== "media-1")
        return deny();
      const m = {
        schema_version: 1,
        representation: "original",
        mime_type: "image/png",
        byte_count: png!.length,
        sha256: createHash("sha256").update(png!).digest("hex"),
        width: 3,
        height: 2,
      };
      return {
        structuredContent: m,
        content: [
          { type: "text", text: JSON.stringify(m) },
          {
            type: "image",
            data: png!.toString("base64"),
            mimeType: m.mime_type,
          },
        ],
      };
    }
    return deny();
  };
  const send = (args: any): any => {
    {
      const action_id = digest([state.session_id, args.idempotency_key]);
      const prior = state.actions.get(action_id);
      if (prior) {
        if (
          prior.generation !== state.generation ||
          prior.text !== args.text ||
          prior.member_ref !== args.member_ref
        )
          return deny("OPERATOR_CONFLICT");
        return { ...prior.receipt, idempotent: true };
      }
      if (state.delivered) return deny("OPERATOR_CONFLICT");
      const receipt = {
        schema_version: 1,
        session_id: state.session_id,
        member_ref: args.member_ref,
        action_id,
        message_id: "message-" + action_id.slice(0, 12),
        status: "delivered",
        idempotent: false,
      };
      state.delivered = action_id;
      state.actions.set(action_id, {
        generation: state.generation,
        text: args.text,
        member_ref: args.member_ref,
        receipt,
      });
      state.messages.push({ text: args.text, generation: state.generation });
      return receipt;
    }
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (req.url === "/v1/chat/completions") {
      calls.push({ path: req.url, body });
      res.setHeader("content-type", "text/event-stream");
      const out = options.provider
        ? await options.provider(body, state, res)
        : answer("Synthetic answer.");
      if (out !== undefined) res.end(out);
      return;
    }
    const name = body.params?.name;
    calls.push({
      path: req.url,
      method: body.method,
      name,
      args: body.params?.arguments,
      body,
    });
    let result: any = {};
    if (body.method === "initialize")
      result = { protocolVersion: "2025-03-26" };
    if (body.method === "tools/list")
      result = {
        tools: Object.entries(schemas)
          .filter(
            ([n]) =>
              options.continuity !== false || ![AUTHORIZE, ADVANCE].includes(n),
          )
          .map(([n, inputSchema]) => ({
            name: n,
            description: [AUTHORIZE, ADVANCE].includes(n)
              ? "Host control only: synthetic."
              : `Synthetic ${n}.`,
            inputSchema,
          })),
      };
    if (body.method === "tools/call") {
      const failure = options.httpFailure?.(name, body.params?.arguments);
      if (failure === "drop") {
        res.destroy();
        return;
      }
      if (failure !== undefined) {
        res.statusCode = failure;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "PRIVATE HTTP FAILURE BODY" }));
        return;
      }
      if (name === "studio_operator_close_session" && options.closeGate)
        await options.closeGate;
      if (name === SEND && options.sendAck === "lost_uncommitted" && lostSend) {
        lostSend--;
        res.destroy();
        return;
      }
      if (
        name === SEND &&
        (options.sendAck === "late_commit" ||
          options.sendAck === "late_after_advance") &&
        lostSend
      ) {
        lostSend--;
        // Still in flight: it lands after the host's first not_found lookup,
        // re-running the generation fence exactly like a transaction retry.
        const args = body.params.arguments;
        lateSend = () => {
          if (
            args.turn_generation === state.generation &&
            state.status === "active"
          )
            send(args);
        };
        res.destroy();
        return;
      }
      const value = tool(name, body.params.arguments);
      if (
        lateSend &&
        ((name === GET &&
          options.sendAck === "late_commit" &&
          value.status === "not_found") ||
          (name === ADVANCE &&
            options.sendAck === "late_after_advance" &&
            !value.isError))
      ) {
        const land = lateSend;
        lateSend = undefined;
        setImmediate(land);
      }
      if (name === SEND && options.sendAck === "lost_committed" && lostSend) {
        lostSend--;
        res.destroy();
        return;
      }
      if (name === ADVANCE && !value.isError && lostAdvance > 0) {
        lostAdvance--;
        res.destroy();
        return;
      }
      result =
        value.isError || (name === IMAGE && options.images)
          ? value
          : { structuredContent: value };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/native-continuity-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "approved-custom-model" },
    token: "synthetic-backend-credential",
    apiKey: "synthetic-provider-credential",
  });
  if (process.env.NATIVE_DOCKER_TEST === "1" && process.env.NATIVE_TEST_IMAGE) {
    try {
      const { provisionArtifact } = await import(
        "../../src/sandbox/artifact.js"
      );
      await provisionArtifact(
        dir,
        process.env.COACH_PACKAGED_ROOT ?? process.cwd(),
        process.env.NATIVE_TEST_IMAGE,
      );
    } catch (error) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  const named = (n: string) => calls.filter((c) => c.name === n);
  return {
    store,
    state,
    calls,
    named,
    providerCalls: () =>
      calls.filter((c) => c.path === "/v1/chat/completions").length,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
