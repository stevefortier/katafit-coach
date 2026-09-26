import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { Actions } from "../chat/actions.js";
import { NativeTerminal } from "./terminal.js";
import { OperatorChat } from "../chat/operator.js";
import type { OperatorAction } from "../katafit/operatorTools.js";
import { StudioReads } from "../katafit/studio.js";
import { Updates } from "../update/updates.js";
import { AutoUpdateSetting } from "../update/auto.js";
import { Diagnostics } from "../diagnostics/log.js";
import { SafeError, safeError } from "../runtime/errors.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { Store, compile, stockPersona } from "../config/store.js";
import { complete } from "../runtime/piAdapter.js";
import { Worker } from "../worker/runner.js";
import { Client } from "../katafit/client.js";
import { effectivePrompt, fetchInstructions } from "../runtime/prompt.js";
export async function admin(
  store: Store,
  port = 4317,
  infer = complete,
  onShutdown?: () => void,
  updates = new Updates(null, null),
  auto?: AutoUpdateSetting,
) {
  const chat = new OperatorChat(store, infer);
  const logs = new Diagnostics(store.dir);
  logs.record({ source: "studio", stage: "studio-started" });
  let worker: Worker | undefined;
  let preview: AbortController | undefined;
  let busy = false;
  let autoQuiesced = false;
  let autoWasRunning = false;
  let autoQuiescePending: Promise<void> | undefined;
  let origin = "";
  const updateSnapshot = async () => {
    const state = updates.snapshot();
    return {
      ...state,
      auto:
        auto && state.supported
          ? { ...(await auto.read()), available: true }
          : { enabled: false, available: false },
    };
  };
  const memberReads = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const ref = randomUUID();
    const started = Date.now();
    let operatorTurnActions: Map<string, OperatorAction> | undefined;
    const send = (status: number, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent)
        res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: "HOST_REJECTED" });
      const path = req.url ?? "/";
      const terminalAssets: Record<string, string> = {
        "/xterm.js": "@xterm/xterm/lib/xterm.js",
        "/xterm.css": "@xterm/xterm/css/xterm.css",
        "/xterm-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
      };
      if (req.method === "GET" && terminalAssets[path]) {
        res.setHeader(
          "Content-Type",
          path.endsWith(".css") ? "text/css" : "text/javascript",
        );
        res.end(await readFile(require.resolve(terminalAssets[path])));
        return;
      }
      const viewPath = path.split("?")[0];
      if (
        (["/", "/settings", "/chat/operator"].includes(viewPath) ||
          /^\/chat\/member\/[^/]+$/.test(viewPath) ||
          ["/app.js", "/terminal.js", "/style.css", "/favicon.svg"].includes(
            path,
          )) &&
        req.method === "GET"
      ) {
        const file =
          ["/", "/settings", "/chat/operator"].includes(viewPath) ||
          /^\/chat\/member\/[^/]+$/.test(viewPath)
            ? "index.html"
            : path.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".svg")
                ? "image/svg+xml"
                : "text/html",
        );
        res.end(await readFile(new URL("../../ui/" + file, import.meta.url)));
        return;
      }
      const key = Buffer.from(
        req.headers.authorization?.replace(/^Bearer /, "") ?? "",
      );
      const expected = Buffer.from(store.secrets.admin);
      if (key.length !== expected.length || !timingSafeEqual(key, expected))
        return send(401, { error: "UNAUTHORIZED" });
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: "ORIGIN_REJECTED" });
      if (req.method === "POST" && req.headers.origin !== origin)
        return send(403, { error: "ORIGIN_REQUIRED" });
      if (req.method === "GET" && path === "/api/terminal/receipts")
        return send(200, { actions: new Actions(store).snapshot() });
      if (req.method === "POST" && path === "/api/terminal/ticket") {
        if (busy || chat.active || updates.applying || autoQuiesced)
          return send(409, { error: "OPERATION_IN_PROGRESS" });
        return send(200, terminal.ticket());
      }
      if (req.method === "POST" && path === "/api/terminal/stop") {
        await terminal.stop();
        return send(200, { stopped: true });
      }
      if (
        req.method === "GET" &&
        path.split("?")[0] &&
        [
          "/api/members",
          "/api/members/feed",
          "/api/members/activities",
          "/api/members/activity",
          "/api/members/media",
        ].includes(path.split("?")[0])
      ) {
        if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
        if (Buffer.byteLength(path) > 20000)
          return send(413, { error: "TOO_LARGE" });
        if (memberReads.size >= 4)
          return send(429, { error: "OPERATION_IN_PROGRESS" });
        const url = new URL(path, origin);
        const feed = url.pathname === "/api/members/feed";
        const kind = url.pathname.split("/").at(-1);
        const allowed =
          kind === "activity"
            ? [
                "member_ref",
                "activity_ref",
                "section",
                "exercise_instance_id",
                "cursor",
              ]
            : kind === "media"
              ? ["member_ref", "media_ref"]
              : kind === "members"
                ? ["cursor"]
                : feed
                  ? ["member_ref", "cursor", "view"]
                  : ["member_ref", "cursor"];
        for (const key of url.searchParams.keys()) {
          const values = url.searchParams.getAll(key);
          if (
            !allowed.includes(key) ||
            values.length !== 1 ||
            !values[0] ||
            values[0].length > 8192
          )
            throw new SafeError("ARGUMENTS_REJECTED");
        }
        const member_ref = url.searchParams.get("member_ref");
        if (
          (kind !== "members" && !member_ref) ||
          (kind === "activity" && !url.searchParams.get("activity_ref")) ||
          (kind === "media" && !url.searchParams.get("media_ref"))
        )
          throw new SafeError("ARGUMENTS_REJECTED");
        const view = url.searchParams.get("view") ?? undefined;
        if (view !== undefined && view !== "main_conversation")
          throw new SafeError("ARGUMENTS_REJECTED");
        const token = store.secrets.token;
        if (!token) throw new SafeError("TOKEN_REQUIRED");
        const c = store.publicConfig();
        const controller = new AbortController();
        memberReads.add(controller);
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]);
          const reads = new StudioReads(
            new Client(c.origin, token, signal),
            Object.values(store.secrets),
          );
          const cursor = url.searchParams.get("cursor") ?? undefined;
          const result = feed
            ? await reads.feed({ member_ref: member_ref!, cursor, view })
            : kind === "activities"
              ? await reads.activities({ member_ref: member_ref!, cursor })
              : kind === "activity"
                ? await reads.activity({
                    member_ref: member_ref!,
                    activity_ref: url.searchParams.get("activity_ref")!,
                    section: url.searchParams.get("section") ?? undefined,
                    exercise_instance_id:
                      url.searchParams.get("exercise_instance_id") ?? undefined,
                    cursor,
                  })
                : kind === "media"
                  ? await reads.media({
                      member_ref: member_ref!,
                      media_ref: url.searchParams.get("media_ref")!,
                    })
                  : await reads.members({ cursor });
          signal.throwIfAborted();
          if (
            store.publicConfig().revision !== c.revision ||
            store.secrets.token !== token ||
            updates.applying
          )
            throw new SafeError("CANCELLED");
          if (kind === "media" && "bytes" in result) {
            res.setHeader("Content-Type", result.mime_type);
            res.setHeader("Content-Length", result.bytes.length);
            res.end(result.bytes);
            return;
          }
          return send(200, result);
        } finally {
          res.removeListener("close", cancel);
          memberReads.delete(controller);
        }
      }
      if (req.method === "GET" && path.startsWith("/api/operator/image?")) {
        const url = new URL(path, origin);
        if (
          [...url.searchParams.keys()].join() !== "id" ||
          !/^[0-9a-f-]{36}$/.test(url.searchParams.get("id") ?? "")
        )
          throw new SafeError("ARGUMENTS_REJECTED");
        const image = await chat.image(url.searchParams.get("id")!);
        res.setHeader("Content-Type", image.mime_type);
        res.setHeader("Content-Length", image.bytes.length);
        res.end(image.bytes);
        return;
      }
      if (req.method === "GET" && path === "/api/operator/chat")
        return send(
          200,
          terminal.active ? chat.snapshot() : await chat.reconcile(),
        );
      if (req.method === "GET" && path === "/api/update")
        return send(200, await updateSnapshot());
      if (req.method === "GET" && path === "/api/config")
        return send(200, {
          ...store.publicConfig(),
          hasToken: !!store.secrets.token,
          hasApiKey: !!store.secrets.apiKey,
        });
      if (
        req.method === "GET" &&
        (path === "/api/persona-history" ||
          path.startsWith("/api/persona-history?"))
      ) {
        const params = new URL(path, origin).searchParams;
        const number = (v: string | null) => {
          if (v === null) return undefined;
          if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)))
            throw new Error("INVALID_REVISION");
          return Number(v);
        };
        if (
          [...params.keys()].some(
            (k) =>
              !["before", "limit"].includes(k) || params.getAll(k).length !== 1,
          )
        )
          throw new Error("INVALID_PAGE");
        return send(
          200,
          store.personaHistory(
            number(params.get("before")),
            number(params.get("limit")),
          ),
        );
      }
      if (req.method === "GET" && path.startsWith("/api/persona-history/")) {
        const id = path.slice("/api/persona-history/".length);
        if (!/^[1-9][0-9]*$/.test(id)) throw new Error("INVALID_REVISION");
        return send(200, store.personaRevision(Number(id)));
      }
      if (req.method === "GET" && path === "/api/persona-defaults")
        return send(200, { persona: stockPersona() });
      if (req.method === "GET" && path === "/api/logs")
        return send(200, logs.snapshot());
      if (req.method === "GET" && path === "/api/status")
        return send(200, {
          state: worker?.state ?? "stopped",
          presence: worker?.presence ?? "unconfirmed",
          preview: !!preview,
          operatorChat: chat.active,
          lastError: logs.lastError,
          revision: store.publicConfig().revision,
          autoQuiesced,
          autoQuiesceReady: autoQuiesced && !autoQuiescePending,
          autoWasRunning: autoQuiesced && autoWasRunning,
        });
      if (req.method !== "POST") return send(404, { error: "NOT_FOUND" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send(415, { error: "JSON_REQUIRED" });
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (Buffer.byteLength(raw) > 65536)
          return send(413, { error: "TOO_LARGE" });
      }
      const body = JSON.parse(raw || "{}");
      if (path === "/api/update/auto") {
        if (!auto && updates.snapshot().supported)
          return send(409, { error: "LAUNCHER_UPGRADE_REQUIRED" });
        if (!auto || !updates.snapshot().supported)
          return send(409, { error: "UNSUPPORTED_INSTALLATION" });
        if (updates.applying && body?.enabled !== false)
          return send(409, { error: "UPDATE_IN_PROGRESS" });
        if (
          !body ||
          Array.isArray(body) ||
          Object.keys(body).join(",") !== "enabled" ||
          typeof body.enabled !== "boolean"
        )
          return send(400, { error: "INVALID_AUTO_SETTING" });
        await auto.write(body.enabled);
        return send(200, { auto: await auto.read() });
      }
      if (path === "/api/update/auto/release" && auto) {
        if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
        if (Object.keys(body).length)
          return send(400, { error: "ARGUMENTS_REJECTED" });
        await autoQuiescePending?.catch(() => {});
        autoQuiesced = false;
        autoWasRunning = false;
        worker?.releaseUpdateQuiesce();
        return send(200, { ok: true });
      }
      if (
        path === "/api/update/auto/quiesce" &&
        auto &&
        updates.snapshot().supported
      ) {
        if (Object.keys(body).length)
          return send(400, { error: "ARGUMENTS_REJECTED" });
        if (autoQuiesced) {
          try {
            await autoQuiescePending;
            return send(200, { wasRunning: autoWasRunning });
          } catch {
            return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
          }
        }
        // Native Pi can SEND and write the action journal; defer rather than
        // let the supervisor snapshot journals under live native work. The
        // check and autoQuiesced are set synchronously, and terminal admission
        // re-checks autoQuiesced, so no native work can begin afterwards.
        if (
          updates.applying ||
          busy ||
          preview ||
          chat.active ||
          !terminal.idle ||
          (worker && worker.state !== "stopped" && !worker.quiesceForUpdate())
        )
          return send(409, { error: "AUTO_UPDATE_BUSY" });
        autoQuiesced = true;
        autoWasRunning = !!worker && worker.state !== "stopped";
        const stopping = (async () => {
          if (autoWasRunning) await worker!.stop();
          if (worker && worker.state !== "stopped")
            throw new Error("WORKER_STOP_UNCONFIRMED");
        })();
        autoQuiescePending = stopping;
        try {
          await stopping;
          return send(200, { wasRunning: autoWasRunning });
        } catch {
          autoQuiesced = false;
          autoWasRunning = false;
          worker?.releaseUpdateQuiesce();
          return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
        } finally {
          if (autoQuiescePending === stopping) autoQuiescePending = undefined;
        }
      }
      if (autoQuiesced) return send(409, { error: "AUTO_UPDATE_QUIESCED" });
      if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
      if (path === "/api/operator/cancel") {
        await chat.cancel();
        return send(200, { ok: true, ...chat.snapshot() });
      }
      if (path === "/api/operator/clear") {
        await chat.clear();
        return send(200, { ok: true, ...chat.snapshot() });
      }
      if (
        chat.active &&
        [
          "/api/operator/chat",
          "/api/config",
          "/api/rollback",
          "/api/persona-restore",
          "/api/update/check",
          "/api/update/apply",
        ].includes(path)
      )
        return send(409, { error: "OPERATOR_CHAT_IN_PROGRESS" });
      if (path === "/api/operator/chat") {
        if (terminal.active)
          return send(409, { error: "OPERATION_IN_PROGRESS" });
        if (busy) return send(409, { error: "OPERATION_IN_PROGRESS" });
        if (
          !body ||
          Array.isArray(body) ||
          !Object.hasOwn(body, "text") ||
          Object.keys(body).some((k) => k !== "text")
        )
          throw new SafeError("INVALID_PREVIEW");
        operatorTurnActions = new Map();
        const cancel = () => chat.cancel();
        res.once("close", cancel);
        // Negotiated JSON streaming: whitespace keeps idle proxies alive while
        // retaining one terminal JSON object. HTTP 200 means accepted; callers
        // must inspect the terminal error field, not just the HTTP status.
        let heartbeat: NodeJS.Timeout | undefined;
        if (req.headers.accept === "application/vnd.katafit.operator+json") {
          res.writeHead(200, {
            "Content-Type": "application/vnd.katafit.operator+json",
            "X-Accel-Buffering": "no",
          });
          res.write("\n");
          heartbeat = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write("\n");
          }, 10000);
          heartbeat.unref();
        }
        try {
          return send(
            200,
            await chat.turn(
              body.text,
              (event) =>
                logs.record({
                  source: event.source,
                  stage: event.stage,
                  level: event.level,
                  metadata: {
                    ...event.metadata,
                    elapsedMs: Date.now() - started,
                  },
                  shape: event.shape,
                  receipt: event.receipt,
                  // Operator evidence remains ephemeral: never persist model/tool
                  // prose, arguments, member references, previews or rejection text.
                  ref,
                }),
              (action) =>
                operatorTurnActions!.set(
                  JSON.stringify([action.session_id, action.idempotency_key]),
                  { ...action },
                ),
            ),
          );
        } finally {
          clearInterval(heartbeat);
          res.removeListener("close", cancel);
        }
      }
      if (path === "/api/update/check") {
        await updates.check();
        return send(200, await updateSnapshot());
      }
      if (path === "/api/update/apply") {
        if (busy || preview || (worker && worker.state !== "stopped"))
          return send(409, {
            error: "PAUSE_BEFORE_UPGRADE",
            hint: "Pause the worker and finish or cancel preview first.",
          });
        if (
          !body ||
          body.confirm !== true ||
          Object.keys(body).sort().join(",") !== "confirm,sha"
        )
          return send(400, { error: "CONFIRM_PINNED_SOURCE" });
        try {
          updates.validate(body.sha);
        } catch (e: any) {
          return send(400, { error: e.message });
        }
        await terminal.stop();
        void updates.apply(body.sha).catch(() => {});
        try {
          await updates.accepted;
        } catch {
          return send(503, {
            error: "UPDATE_NOT_ACCEPTED",
            hint: "Could not persist the update request. Check protected home storage.",
          });
        }
        return send(202, { ok: true });
      }
      if (path === "/api/shutdown" && onShutdown) {
        await terminal.stop();
        await chat.cancel();
        preview?.abort();
        send(200, { ok: true });
        setImmediate(onShutdown);
        return;
      }
      if (path === "/api/cancel") {
        preview?.abort();
        return send(200, { ok: true });
      }
      if (busy) return send(409, { error: "OPERATION_IN_PROGRESS" });
      busy = true;
      try {
        if (
          ["/api/config", "/api/rollback", "/api/persona-restore"].includes(
            path,
          )
        ) {
          if (worker && worker.state !== "stopped")
            return send(409, { error: "STOP_WORKER_BEFORE_CONFIGURE" });
          await terminal.stop();
          if (path === "/api/config") {
            chat.assertSecrets([
              ...Object.values(store.secrets),
              ...[body?.apiKey, body?.token].filter(
                (v): v is string => typeof v === "string",
              ),
            ]);
            await store.save(body);
          } else if (path === "/api/persona-restore") {
            if (
              !body ||
              Array.isArray(body) ||
              Object.keys(body).join() !== "revision"
            )
              throw new Error("INVALID_REVISION");
            await store.restorePersona(body.revision);
          } else await store.rollback();
          await chat.cancel();
          return send(200, { ok: true });
        }
        if (path === "/api/connect") {
          if (!store.secrets.token) throw new Error("TOKEN_REQUIRED");
          const c = new Client(
            store.publicConfig().origin,
            store.secrets.token,
            AbortSignal.timeout(10000),
          );
          await c.connect();
          await c.call("coach_list_requests", { limit: 1 });
          return send(200, {
            ok: true,
            message:
              "Credential accepted. This is connectivity, not a completed Coach reply.",
          });
        }
        if (path === "/api/preview") {
          if (worker && worker.state !== "stopped")
            throw new Error("STOP_WORKER_BEFORE_PREVIEW");
          if (
            typeof body.text !== "string" ||
            !body.text.trim() ||
            body.text.length > 8000
          )
            throw new Error("INVALID_PREVIEW");
          preview = new AbortController();
          const previewRef = ref;
          logs.record({
            source: "studio",
            stage: "preview-started",
            ref: previewRef,
          });
          const controller = preview;
          const cancel = () => controller.abort();
          res.once("close", cancel);
          try {
            const c = store.publicConfig();
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(60000),
            ]);
            const instructions = await fetchInstructions(
              new Client(c.origin, store.secrets.token, signal),
            ).catch(() => {
              if (controller.signal.aborted) throw new SafeError("CANCELLED");
              throw new Error("BACKEND_INSTRUCTIONS_UNAVAILABLE");
            });
            const prompt = effectivePrompt(
              compile(c, Object.values(store.secrets)),
              instructions,
              Object.values(store.secrets),
            );
            const text = await infer(
              {
                ...c.provider,
                onDiagnostic: (event) =>
                  logs.record({ ...event, ref: previewRef }),
                apiKey: store.secrets.apiKey,
                secrets: Object.values(store.secrets),
              },
              prompt,
              body.text,
              signal,
            );
            for (const secret of [
              store.secrets.token,
              store.secrets.apiKey,
              store.secrets.admin,
            ])
              if (secret && text.includes(secret))
                throw new Error("OUTPUT_REJECTED");
            logs.record({
              source: "studio",
              stage: "preview-completed",
              ref: previewRef,
            });
            return send(200, {
              text,
              prompt,
              revision: c.revision,
              instructionsStatus: "fetched",
              configuration: "saved",
              dataAuthority:
                "none: preview has no claimed request or data tools",
            });
          } finally {
            res.removeListener("close", cancel);
            preview = undefined;
          }
        }
        if (path === "/api/run") {
          if (!store.secrets.token || !store.secrets.apiKey)
            throw new Error("CONNECTION_AND_PROVIDER_REQUIRED");
          if (!worker || worker.state === "stopped") {
            const c = store.publicConfig();
            worker = new Worker({
              origin: c.origin,
              token: store.secrets.token,
              system: compile(c, Object.values(store.secrets)),
              secrets: Object.values(store.secrets),
              vision: c.provider.vision === true,
              onDiagnostic: (event) => logs.record(event),
              complete: (context, signal, system, tools, ref, budget) =>
                infer(
                  {
                    ...c.provider,
                    onDiagnostic: (event) => logs.record({ ...event, ref }),
                    apiKey: store.secrets.apiKey,
                    secrets: Object.values(store.secrets),
                  },
                  system,
                  context,
                  signal,
                  tools,
                  budget,
                ),
            });
            try {
              await worker.start();
            } catch (error) {
              await worker.stop();
              throw error;
            }
          }
          return send(200, { ok: true, presence: worker.presence });
        }
        if (path === "/api/stop") {
          await worker?.stop();
          return send(200, {
            ok: true,
            presence: worker?.presence ?? "unconfirmed",
          });
        }
        return send(404, { error: "NOT_FOUND" });
      } finally {
        busy = false;
      }
    } catch (e: any) {
      const failure = safeError(e);
      logs.record({
        source: "studio",
        stage: failure.code === "CANCELLED" ? "cancelled" : "operation-failed",
        level: failure.code === "CANCELLED" ? "warn" : "error",
        ref,
        metadata: { elapsedMs: Date.now() - started },
        error: failure,
      });
      let operatorOutcome: Record<string, unknown> = {};
      if (req.url?.startsWith("/api/operator/")) {
        operatorOutcome = {
          hint:
            (failure.code === "CONTRACT_UNSUPPORTED"
              ? "This backend does not support operator commands. "
              : "") +
            "Operator turn did not complete. Review action receipts before any retry; delivered messages are not undone by Cancel or Clear.",
          receiptsUnavailable: true,
        };
        try {
          const actions = chat.snapshot().actions;
          const turnActions = operatorTurnActions
            ? [...operatorTurnActions.values()]
            : undefined;
          operatorOutcome = {
            ...operatorOutcome,
            actions,
            turnActions,
            hint: (turnActions ?? actions).length
              ? failure.hint + " Review action receipts before retry."
              : failure.hint,
            receiptsUnavailable: false,
          };
        } catch {}
      }
      send(400, {
        error: failure.code,
        hint: failure.hint,
        metadata: failure.metadata,
        ...operatorOutcome,
      });
    }
  });
  const terminal = new NativeTerminal(
    store,
    server,
    () => origin,
    () => !busy && !chat.active && !updates.applying && !autoQuiesced,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    async close() {
      await terminal.close();
      for (const controller of memberReads) controller.abort();
      await chat.cancel();
      preview?.abort();
      await worker?.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
