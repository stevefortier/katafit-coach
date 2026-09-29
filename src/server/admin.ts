import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { Actions } from "../chat/actions.js";
import { NativeTerminal } from "./terminal.js";
import { contentDisposition } from "../sandbox/attachments.js";
import { StudioReads } from "../katafit/studio.js";
import { restGet } from "../katafit/restGet.js";
import { Updates } from "../update/updates.js";
import { AutoUpdateSetting } from "../update/auto.js";
import { Diagnostics } from "../diagnostics/log.js";
import { SafeError, safeError } from "../runtime/errors.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import {
  Store,
  compile,
  stockPersona,
  assertNoSecrets,
} from "../config/store.js";
import { complete } from "../runtime/piAdapter.js";
import { Worker } from "../worker/runner.js";
import { Client, ToolFailure } from "../katafit/client.js";
import { effectivePrompt, fetchInstructions } from "../runtime/prompt.js";
import { archiveTaskInvalidation } from "../worker/taskInvalidationArchive.js";
// The stable runtime imports this value from the selected application module.
// Absence means a legacy one-step admin; never infer capability from source text.
export const updatePreparationProtocol = 1;
export async function admin(
  store: Store,
  port = 4317,
  infer = complete,
  onShutdown?: () => void,
  updates = new Updates(null, null),
  auto?: AutoUpdateSetting,
) {
  const logs = new Diagnostics(store.dir);
  const onBackendDiagnostic = (
    event: import("../diagnostics/log.js").LogInput,
  ) => logs.record(event);
  logs.record({ source: "studio", stage: "studio-started" });
  const initialSkills = store.skills.runtime();
  logs.record({
    source: "studio",
    stage: "skills-loaded",
    metadata: {
      skillRevision: initialSkills.revision,
      enabledSkills: initialSkills.skills.length,
    },
  });
  let worker: Worker | undefined;
  // Preview is isolated from worker/native lifecycle: it never holds `busy`,
  // but it excludes configuration mutation and update admission.
  let preview: AbortController | undefined;
  let previewDone = Promise.resolve();
  let busy = false;
  let configurationUncertain = false;
  let closing = false;
  let lifecycleDone = Promise.resolve();
  let autoQuiesced = false;
  let autoWasRunning = false;
  let autoQuiescePending: Promise<void> | undefined;
  let nextPublicationRecovery = 0;
  // Child-owned compatibility path: existing stable owners already call
  // quiesce/release. Never stop an idle worker just to inspect a receipt.
  const reconcileForAutomaticUpdate = async () => {
    if (
      !worker ||
      worker.safeToReplace ||
      busy ||
      preview ||
      !terminal.idle ||
      updates.applying ||
      closing ||
      Date.now() < nextPublicationRecovery ||
      !["idle", "stopped"].includes(worker.state)
    )
      return;
    nextPublicationRecovery = Date.now() + 60000;
    busy = true; // Fence native and admin admission throughout read/archive.
    try {
      await worker.reconcilePublications(true);
    } catch {
      // A raced claim or failed read is deferral, never replacement authority.
    } finally {
      busy = false;
    }
  };
  const completed = new Map<
    string,
    { fingerprint: string; status: number; data: unknown }
  >();
  let origin = "";
  const memoryError = (error: unknown) => {
    if (error instanceof ToolFailure && error.code?.startsWith("MEMORY_"))
      return {
        status:
          error.code === "MEMORY_UNAVAILABLE"
            ? 503
            : error.code === "MEMORY_LIMIT"
              ? 413
              : error.code === "MEMORY_INVALID"
                ? 400
                : error.code === "MEMORY_NOT_AUTHORIZED"
                  ? 403
                  : 409,
        body: {
          error: error.code,
          hint:
            error.code === "MEMORY_UNAVAILABLE"
              ? "Backend durable memory is temporarily unavailable. No memory prose was disclosed."
              : "Backend durable memory denied this operation under current authority.",
        },
      };
    return null;
  };
  const memoryOperation = (signal = AbortSignal.timeout(15000)) => {
    const config = store.publicConfig();
    const token = store.secrets.token;
    const credentials = { ...store.secrets };
    const fence = () => {
      signal.throwIfAborted();
      const current = store.publicConfig();
      if (
        current.revision !== config.revision ||
        current.origin !== config.origin ||
        JSON.stringify(store.secrets) !== JSON.stringify(credentials) ||
        updates.applying ||
        closing
      )
        throw new SafeError("CANCELLED");
      if (!token) throw new SafeError("CREDENTIAL_REJECTED");
    };
    return async (name: string, args: unknown) => {
      fence();
      assertNoSecrets(args, Object.values(credentials));
      const client = new Client(config.origin, token, signal, (event) =>
        logs.record(event),
      );
      await client.connect();
      fence();
      const result = await client.call(name, args, 15000);
      fence();
      assertNoSecrets(result, Object.values(credentials));
      return result;
    };
  };
  const memoryCall = (name: string, args: unknown) =>
    memoryOperation()(name, args);
  // One server-owned operation holds busy from admission through resume. HTTP
  // disconnects never cancel configuration application or restart recovery.
  let lifecycle:
    | {
        id: string;
        operation: string;
        phase: string;
        wasRunning: boolean;
        running: boolean;
        applied: boolean;
        resumed: boolean;
        error?: string;
        hint?: string;
        applicationUncertain?: boolean;
      }
    | undefined;
  const startWorker = async () => {
    if (closing) throw new SafeError("CANCELLED");
    if (configurationUncertain)
      throw new SafeError("CONFIGURATION_STATE_UNCONFIRMED");
    if (
      worker?.state === "stopped" &&
      (!worker.stopConfirmed || !worker.safeToReplace)
    )
      throw new SafeError("WORKER_STOP_UNCONFIRMED");
    if (!store.secrets.token || !store.secrets.apiKey)
      throw new Error("CONNECTION_AND_PROVIDER_REQUIRED");
    if (!worker || worker.state === "stopped") {
      // Capture the active endpoint and its key together.
      const c = store.publicConfig();
      const apiKey = store.secrets.apiKey;
      const skills = store.skills.runtime();
      worker = new Worker({
        origin: c.origin,
        token: store.secrets.token,
        system: compile(c, Object.values(store.secrets)),
        secrets: Object.values(store.secrets),
        vision: c.provider.vision === true,
        skills,
        personaRevision: String(c.revision),
        onDiagnostic: (event) => logs.record(event),
        archiveTaskInvalidation: (record) =>
          archiveTaskInvalidation(store.dir, record),
        complete: (context, signal, system, tools, ref, budget) =>
          infer(
            {
              ...c.provider,
              onDiagnostic: (event) => logs.record({ ...event, ref }),
              apiKey,
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
  };
  const transition = async <T>(
    operation: string,
    body: any,
    apply: () => Promise<T>,
  ) => {
    const wasRunning = !!worker && worker.state !== "stopped";
    if ((wasRunning || terminal.active) && body.confirmRestart !== true)
      throw new SafeError("RESTART_CONFIRMATION_REQUIRED");
    let settled!: () => void;
    lifecycleDone = new Promise<void>((resolve) => {
      settled = resolve;
    });
    lifecycle = {
      id: body.operationId ?? randomUUID(),
      operation,
      phase: "stopping",
      wasRunning,
      running: wasRunning,
      applied: false,
      resumed: false,
    };
    let safeToResume = false;
    try {
      await terminal.stop();
      if (wasRunning) await worker!.stop();
      if (
        worker?.state === "stopped" &&
        worker.stopConfirmed &&
        !worker.safeToReplace
      )
        await worker.reconcilePublications();
      if (worker && (!worker.stopConfirmed || !worker.safeToReplace))
        throw new SafeError("WORKER_STOP_UNCONFIRMED");
      safeToResume = true;
      lifecycle.phase = "applying";
      const result = await apply();
      lifecycle.applied = true;
      return result;
    } catch (error) {
      const failure = safeError(error);
      lifecycle.error = failure.code;
      lifecycle.hint = failure.hint;
      if (safeToResume) {
        try {
          const disk = new Store(store.dir);
          await disk.init();
          if (
            JSON.stringify(disk.publicConfig()) !==
              JSON.stringify(store.publicConfig()) ||
            JSON.stringify(disk.skills.view()) !==
              JSON.stringify(store.skills.view()) ||
            disk.secrets.apiKey !== store.secrets.apiKey ||
            disk.secrets.token !== store.secrets.token
          )
            throw new Error("CONFIGURATION_STATE_UNCONFIRMED");
        } catch {
          safeToResume = false;
          configurationUncertain = true;
          lifecycle.applicationUncertain = true;
          lifecycle.error = "CONFIGURATION_STATE_UNCONFIRMED";
          lifecycle.hint = safeError(
            new SafeError("CONFIGURATION_STATE_UNCONFIRMED"),
          ).hint;
        }
      }
      throw error;
    } finally {
      if (wasRunning && safeToResume && !closing) {
        lifecycle.phase = "restarting";
        try {
          await startWorker();
          lifecycle.resumed = true;
        } catch {
          lifecycle.error = "COACH_RESTART_FAILED";
          lifecycle.hint =
            "Coach could not restart. Retry starts the saved revision only; it never saves again or replays chat or actions.";
        }
      }
      lifecycle.running = !!worker && worker.state !== "stopped";
      lifecycle.phase = "complete";
      settled();
    }
  };

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
    let acceptedId: string | undefined;
    let fingerprint = "";
    // Preview outcomes never carry the unrelated last lifecycle result.
    let previewRequest = false;
    const send = (status: number, data: unknown) => {
      if (acceptedId) {
        completed.set(acceptedId, { fingerprint, status, data });
        while (completed.size > 32)
          completed.delete(completed.keys().next().value!);
      }
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent)
        res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: https://tile.openstreetmap.org; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: "HOST_REJECTED" });
      const path = req.url ?? "/";
      const terminalAssets: Record<string, string> = {
        "/xterm.js": "@xterm/xterm/lib/xterm.js",
        "/xterm.css": "@xterm/xterm/css/xterm.css",
        "/xterm-fit.js": "@xterm/addon-fit/lib/addon-fit.js",
        "/leaflet.js": "leaflet/dist/leaflet.js",
        "/leaflet.css": "leaflet/dist/leaflet.css",
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
        ([
          "/",
          "/settings",
          "/diagnostics",
          "/dashboard",
          "/chat/operator",
        ].includes(viewPath) ||
          /^\/chat\/member\/[^/]+$/.test(viewPath) ||
          [
            "/backend-performance.js",
            "/dashboard.js",
            "/app.js",
            "/terminal.js",
            "/style.css",
            "/favicon.svg",
          ].includes(path)) &&
        req.method === "GET"
      ) {
        const file =
          [
            "/",
            "/settings",
            "/diagnostics",
            "/dashboard",
            "/chat/operator",
          ].includes(viewPath) || /^\/chat\/member\/[^/]+$/.test(viewPath)
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
      if (req.method === "GET" && /^\/api\/dashboard(?:[/?]|$)/.test(path)) {
        if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
        if (memberReads.size >= 4)
          return send(429, { error: "OPERATION_IN_PROGRESS" });
        const url = new URL(path, origin);
        const params = url.searchParams;
        const allowed =
          url.pathname === "/api/dashboard"
            ? ["before"]
            : url.pathname === "/api/dashboard/map"
              ? ["date", "start", "end", "cursor"]
              : url.pathname === "/api/dashboard/activity"
                ? ["id"]
                : url.pathname === "/api/dashboard/avatar"
                  ? ["id"]
                  : url.pathname === "/api/dashboard/photo"
                    ? ["activity_id", "file_id"]
                    : [];
        if (
          !allowed.length ||
          [...params.keys()].some(
            (k) => !allowed.includes(k) || params.getAll(k).length !== 1,
          )
        )
          throw new SafeError("ARGUMENTS_REJECTED");
        const segment = (key: string) => {
          const value = params.get(key);
          if (!value || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
            throw new SafeError("ARGUMENTS_REJECTED");
          return value;
        };
        let target: string;
        const photo = url.pathname === "/api/dashboard/photo";
        const avatar = url.pathname === "/api/dashboard/avatar";
        if (photo)
          target = `/api/media/${segment("activity_id")}/files/${segment("file_id")}`;
        else if (avatar) {
          const id = params.get("id");
          if (!id || !/^[a-f0-9]{24}$/.test(id))
            throw new SafeError("ARGUMENTS_REJECTED");
          target = `/api/users/${id}/avatar/64`;
        } else if (url.pathname === "/api/dashboard/activity")
          target = `/api/friends/activity/${segment("id")}`;
        else {
          const before = params.get("before");
          if (
            before &&
            (before.length > 64 || !Number.isFinite(Date.parse(before)))
          )
            throw new SafeError("ARGUMENTS_REJECTED");
          if (url.pathname === "/api/dashboard/map") {
            const date = params.get("date");
            const start = params.get("start");
            const end = params.get("end");
            const cursor = params.get("cursor");
            const day = date ? Date.parse(date + "T00:00:00.000Z") : NaN;
            const startTime = start ? Date.parse(start) : NaN;
            const endTime = end ? Date.parse(end) : NaN;
            const hour = 60 * 60 * 1000;
            if (
              !date ||
              !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              !Number.isFinite(day) ||
              new Date(day).toISOString().slice(0, 10) !== date ||
              !start ||
              !end ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(start) ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(end) ||
              !Number.isFinite(startTime) ||
              !Number.isFinite(endTime) ||
              new Date(startTime).toISOString() !== start ||
              new Date(endTime).toISOString() !== end ||
              Math.abs(startTime - day) > 14 * hour ||
              Math.abs(endTime - (day + 24 * hour)) > 14 * hour ||
              endTime - startTime < 23 * hour ||
              endTime - startTime > 25 * hour ||
              (cursor &&
                (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
            )
              throw new SafeError("ARGUMENTS_REJECTED");
            target =
              "/api/friends/dojo/positioned-activities?start=" +
              encodeURIComponent(start) +
              "&end=" +
              encodeURIComponent(end) +
              "&limit=100" +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
          } else {
            target =
              "/api/friends/feed/dojo?limit=20" +
              (before ? "&beforeDate=" + encodeURIComponent(before) : "");
          }
        }
        const token = store.secrets.token;
        if (!token) throw new SafeError("TOKEN_REQUIRED");
        const c = store.publicConfig();
        const controller = new AbortController();
        memberReads.add(controller);
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          const result = await restGet(
            c.origin,
            token,
            { path: target },
            controller.signal,
            Object.values(store.secrets),
          );
          controller.signal.throwIfAborted();
          if (
            store.publicConfig().revision !== c.revision ||
            store.secrets.token !== token ||
            updates.applying
          )
            throw new SafeError("CANCELLED");
          if (result.restReadError)
            return send(result.restReadError.status, {
              error: "REST_READ_DENIED",
              status: result.restReadError.status,
            });
          if (photo || avatar) {
            const image = result.content?.find((part) => part.type === "image");
            if (!image || !("data" in image))
              throw new SafeError("RESULT_REJECTED");
            const bytes = Buffer.from(image.data!, "base64");
            res.setHeader("Content-Type", image.mimeType!);
            res.setHeader("Content-Length", bytes.length);
            res.end(bytes);
          } else {
            const text = result.content?.find((part) => part.type === "text");
            if (!text || !("text" in text))
              throw new SafeError("RESULT_REJECTED");
            return send(200, JSON.parse(text.text!));
          }
        } finally {
          res.removeListener("close", cancel);
          memberReads.delete(controller);
        }
        return;
      }
      if (req.method === "GET" && path === "/api/terminal/receipts")
        return send(200, {
          actions: new Actions(store, onBackendDiagnostic).snapshot(),
        });

      if (
        req.method === "GET" &&
        path.startsWith("/api/terminal/attachments/")
      ) {
        const match =
          /^\/api\/terminal\/attachments\/([a-f0-9]{32})\/(at_[a-f0-9]{32})$/.exec(
            path,
          );
        if (!match) return send(404, { error: "NOT_FOUND" });
        let entry: Awaited<ReturnType<typeof terminal.attachment>>;
        try {
          entry = await terminal.attachment(match[1], match[2]);
        } catch (error: any) {
          const code = error?.message;
          if (code === "ATTACHMENT_NOT_FOUND")
            return send(404, { error: "NOT_FOUND" });
          // Recoverable: Pi busy, backend outage, or a human turn is needed.
          if (code === "ATTACHMENT_AUTHORIZATION_BUSY") {
            res.setHeader("Retry-After", "2");
            return send(503, { error: code });
          }
          if (code === "ATTACHMENT_AUTHORIZATION_UNAVAILABLE") {
            res.setHeader("Retry-After", "5");
            return send(503, { error: code });
          }
          if (code === "ATTACHMENT_TURN_REQUIRED")
            return send(409, { error: code });
          if (code === "ATTACHMENT_UNAVAILABLE")
            return send(409, { error: "OPERATION_IN_PROGRESS" });
          return send(410, { error: "ATTACHMENT_REVOKED" });
        }
        res.writeHead(200, {
          "Content-Type":
            entry.item.preview === "image"
              ? entry.item.mime_type
              : "application/octet-stream",
          "Content-Length": entry.bytes.length,
          "Content-Disposition": contentDisposition(entry.item.filename),
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        res.end(entry.bytes);
        return;
      }
      if (req.method === "POST" && path === "/api/terminal/ticket") {
        if (
          closing ||
          busy ||
          configurationUncertain ||
          updates.applying ||
          updates.recovering ||
          autoQuiesced
        )
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
            new Client(c.origin, token, signal, onBackendDiagnostic),
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
      if (req.method === "GET" && path === "/api/update")
        return send(200, await updateSnapshot());
      if (req.method === "GET" && path === "/api/config")
        return send(200, {
          ...store.publicConfig(),
          models: store.modelRegistry(),
          hasToken: !!store.secrets.token,
          hasApiKey: !!store.secrets.apiKey,
        });
      if (req.method === "GET" && path === "/api/skills")
        return send(200, store.skills.view());
      if (req.method === "GET" && path === "/api/skills/history")
        return send(200, store.skills.historyList());
      if (req.method === "GET" && path.startsWith("/api/skills/history/")) {
        const id = path.slice("/api/skills/history/".length);
        if (!/^[1-9][0-9]*$/.test(id))
          throw new Error("INVALID_SKILL_REVISION");
        return send(200, store.skills.history(Number(id)));
      }
      if (
        req.method === "GET" &&
        (path === "/api/memories" || path.startsWith("/api/memories?"))
      ) {
        const url = new URL(path, origin);
        const params = url.searchParams;
        if (
          [...params.keys()].some(
            (key) =>
              ![
                "status",
                "audience",
                "kind",
                "query",
                "q",
                "member_ref",
                "pinned",
                "limit",
                "cursor",
                "include_archived",
                "scope",
              ].includes(key) || params.getAll(key).length !== 1,
          )
        )
          throw new Error("INVALID_MEMORY");
        const legacyScope = params.get("scope");
        const audience =
          params.get("audience") ||
          (legacyScope === "member"
            ? "member_private"
            : legacyScope === "dojo"
              ? "member_coach"
              : legacyScope === "boss" || legacyScope === "coach"
                ? "operator_private"
                : undefined);
        const result = await memoryCall("studio_memory_list", {
          ...(params.get("status")
            ? { status: params.get("status") }
            : params.get("include_archived") === "true"
              ? { status: "all" }
              : {}),
          ...(audience ? { audience } : {}),
          ...(params.get("kind") ? { kind: params.get("kind") } : {}),
          ...(params.get("query") || params.get("q")
            ? { query: params.get("query") || params.get("q") }
            : {}),
          ...(params.get("member_ref")
            ? { member_ref: params.get("member_ref") }
            : {}),
          ...(params.get("pinned")
            ? { pinned: params.get("pinned") === "true" }
            : {}),
          ...(params.get("limit")
            ? { limit: Number(params.get("limit")) }
            : {}),
          ...(params.get("cursor") ? { cursor: params.get("cursor") } : {}),
        });
        return send(200, result);
      }
      if (
        req.method === "GET" &&
        /^\/api\/memories\/(?:history\/)?[a-f0-9]{24}$/i.test(path)
      ) {
        const id = path.split("/").at(-1)!;
        return send(
          200,
          await memoryCall("studio_memory_get", { memory_id: id }),
        );
      }
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
          safeToReplace: worker?.safeToReplace ?? true,
          stopConfirmed: worker?.stopConfirmed ?? true,
          nativeActive: terminal.active,
          lastError: logs.lastError,
          revision: store.publicConfig().revision,
          skillsRevision: store.skills.runtime().revision,
          lifecycle,
          transition: busy,
          autoQuiesced,
          autoQuiesceReady:
            autoQuiesced && !autoQuiescePending && terminal.idle,
          autoWasRunning: autoQuiesced && autoWasRunning,
        });
      if (req.method !== "POST") return send(404, { error: "NOT_FOUND" });
      if (closing) return send(503, { error: "SERVICE_CLOSING" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send(415, { error: "JSON_REQUIRED" });
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (Buffer.byteLength(raw) > 65536)
          return send(413, { error: "TOO_LARGE" });
      }
      const input = JSON.parse(raw || "{}");

      if (!input || typeof input !== "object" || Array.isArray(input))
        return send(400, { error: "ARGUMENTS_REJECTED" });
      const { confirmRestart, operationId, expectedRevision, ...body } = input;
      const skillMutation =
        /^\/api\/skills\/([a-z][a-z0-9-]{0,63})(\/restore-default)?$/.exec(
          path,
        );
      const configuration =
        ["/api/config", "/api/rollback", "/api/persona-restore"].includes(
          path,
        ) || !!skillMutation;
      if (
        (operationId !== undefined || expectedRevision !== undefined) &&
        !configuration
      )
        return send(400, { error: "ARGUMENTS_REJECTED" });
      if (
        operationId !== undefined &&
        (typeof operationId !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            operationId,
          ) ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 1)
      )
        return send(400, { error: "ARGUMENTS_REJECTED" });
      if (operationId) {
        fingerprint = createHash("sha256")
          .update(path + raw)
          .digest("hex");
        const prior = completed.get(operationId);
        if (prior)
          return prior.fingerprint === fingerprint
            ? send(prior.status, prior.data)
            : send(409, { error: "OPERATION_ID_REUSED" });
      }
      if (
        configuration &&
        expectedRevision !== undefined &&
        expectedRevision !==
          (skillMutation
            ? store.skills.runtime().revision
            : store.publicConfig().revision)
      )
        return send(409, {
          error: skillMutation ? "SKILLS_CHANGED" : "CONFIGURATION_CHANGED",
          hint: skillMutation
            ? "Skills changed after this editor loaded. Refresh and review the saved revision before applying your retained draft."
            : "The saved revision changed. Check the saved configuration before applying your retained draft.",
        });
      if (
        skillMutation &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      )
        return send(400, { error: "INVALID_SKILL_REVISION" });
      if (
        confirmRestart !== undefined &&
        (typeof confirmRestart !== "boolean" ||
          (!configuration && path !== "/api/preview"))
      )
        return send(400, { error: "ARGUMENTS_REJECTED" });
      if (
        configurationUncertain &&
        !["/api/stop", "/api/cancel", "/api/shutdown"].includes(path)
      )
        throw new SafeError("CONFIGURATION_STATE_UNCONFIRMED");
      if (path === "/api/update/auto") {
        if (!auto && updates.snapshot().supported)
          return send(409, { error: "LAUNCHER_UPGRADE_REQUIRED" });
        if (!auto || !updates.snapshot().supported)
          return send(409, { error: "UNSUPPORTED_INSTALLATION" });
        if ((updates.applying || updates.preparing) && body?.enabled !== false)
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
        if (busy) return send(409, { error: "OPERATION_IN_PROGRESS" });
        if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
        if (Object.keys(body).length)
          return send(400, { error: "ARGUMENTS_REJECTED" });
        await autoQuiescePending?.catch(() => {});
        await reconcileForAutomaticUpdate();
        if (
          autoQuiesced &&
          (!terminal.idle ||
            (worker && (!worker.stopConfirmed || !worker.safeToReplace)))
        )
          return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
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
        await reconcileForAutomaticUpdate();
        if (autoQuiesced) {
          try {
            await autoQuiescePending;
            if (
              !terminal.idle ||
              (worker && (!worker.stopConfirmed || !worker.safeToReplace))
            )
              throw new Error("WORKER_STOP_UNCONFIRMED");
            return send(200, { wasRunning: autoWasRunning });
          } catch {
            return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
          }
        }
        // Fence new native admission before stopping Pi. The sandbox and its
        // gateway must finish teardown (including action reconciliation) before
        // the owner can snapshot protected journals or replace this process.
        if (
          updates.applying ||
          updates.recovering ||
          busy ||
          preview ||
          (worker && worker.state !== "stopped" && !worker.quiesceForUpdate())
        )
          return send(409, { error: "AUTO_UPDATE_BUSY" });
        autoQuiesced = true;
        autoWasRunning = !!worker && worker.state !== "stopped";
        const stopping = (async () => {
          await terminal.stop();
          if (autoWasRunning) await worker!.stop();
          if (
            !terminal.idle ||
            (worker && (!worker.stopConfirmed || !worker.safeToReplace))
          )
            throw new Error("WORKER_STOP_UNCONFIRMED");
        })();
        autoQuiescePending = stopping;
        try {
          await stopping;
          return send(200, { wasRunning: autoWasRunning });
        } catch {
          // Keep the admission barrier and pre-stop intent until the owner
          // reads status and explicitly releases it, including lost replies.
          return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
        } finally {
          if (autoQuiescePending === stopping) autoQuiescePending = undefined;
        }
      }
      if (autoQuiesced && path !== "/api/worker/reconcile")
        return send(409, { error: "AUTO_UPDATE_QUIESCED" });
      if (updates.applying) return send(409, { error: "UPDATE_IN_PROGRESS" });
      if (
        updates.recovering &&
        !["/api/update/resume", "/api/worker/reconcile"].includes(path)
      )
        return send(409, {
          error: "UPDATE_RECOVERING",
          hint: "The launcher is restoring Coach. Check worker status; do not reapply the update.",
        });
      if (busy && path !== "/api/cancel")
        return send(
          409,
          path === "/api/preview"
            ? {
                error: "OPERATION_IN_PROGRESS",
                hint: "Another Coach operation is finishing. Nothing was stopped or changed; retry preview shortly.",
              }
            : { error: "OPERATION_IN_PROGRESS" },
        );
      const memoryMutation =
        /^\/api\/memories(?:\/([a-f0-9]{24})(?:\/(archive|forget))?)?$/i.exec(
          path,
        );
      if (memoryMutation) {
        const [, id, action] = memoryMutation;
        const call = memoryOperation();
        if (!id) {
          const result = await call("studio_memory_create", {
            idempotency_key:
              typeof body.idempotency_key === "string"
                ? body.idempotency_key
                : randomUUID(),
            audience: body.audience,
            ...(body.member_ref ? { member_ref: body.member_ref } : {}),
            kind: body.kind,
            text: body.text,
            ...(body.confidence !== undefined
              ? { confidence: body.confidence }
              : {}),
            ...(body.importance !== undefined
              ? { importance: body.importance }
              : {}),
            ...(body.goal_relevance !== undefined
              ? { goal_relevance: body.goal_relevance }
              : {}),
            ...(body.review_at !== undefined
              ? { review_at: body.review_at || null }
              : {}),
            ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          });
          return send(200, result);
        }
        if (action === "forget") {
          const result = await call("studio_memory_forget", {
            memory_id: id,
            ...(body.expected_revision !== undefined
              ? { expected_revision: body.expected_revision }
              : {}),
          });
          return send(200, result);
        }
        const expected =
          body.expected_revision ??
          (await call("studio_memory_get", { memory_id: id })).item?.revision;
        const result = await call("studio_memory_update", {
          memory_id: id,
          expected_revision: expected,
          ...(action === "archive"
            ? { status: "archived" }
            : {
                ...(body.text !== undefined ? { text: body.text } : {}),
                ...(body.kind !== undefined ? { kind: body.kind } : {}),
                ...(body.confidence !== undefined
                  ? { confidence: body.confidence }
                  : {}),
                ...(body.importance !== undefined
                  ? { importance: body.importance }
                  : {}),
                ...(body.goal_relevance !== undefined
                  ? { goal_relevance: body.goal_relevance }
                  : {}),
                ...(body.review_at !== undefined
                  ? { review_at: body.review_at || null }
                  : {}),
                ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
                ...(body.protected !== undefined
                  ? { protected: body.protected }
                  : {}),
                ...(body.status !== undefined ? { status: body.status } : {}),
              }),
        });
        return send(200, result);
      }
      if (path === "/api/worker/reconcile") {
        if (Object.keys(input).length)
          return send(400, { error: "ARGUMENTS_REJECTED" });
        if (worker && worker.state !== "stopped")
          return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
        busy = true;
        try {
          await worker?.reconcilePublications();
          const safeToReplace = worker?.safeToReplace ?? true;
          const stopConfirmed = worker?.stopConfirmed ?? true;
          const ready = safeToReplace && stopConfirmed;
          return send(ready ? 200 : 409, {
            safeToReplace,
            stopConfirmed,
            ...(!ready ? { error: "WORKER_STOP_UNCONFIRMED" } : {}),
          });
        } finally {
          busy = false;
        }
      }
      if (path === "/api/update/check") {
        await updates.check();
        return send(200, await updateSnapshot());
      }
      if (path === "/api/update/apply") {
        if (busy || preview)
          return send(409, {
            error: "OPERATION_IN_PROGRESS",
            hint: "Finish or cancel preview before upgrading.",
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
        const wasRunning = !!worker && worker.state !== "stopped";
        if (wasRunning && updates.snapshot().preparationSupported !== true)
          return send(409, {
            error: "LAUNCHER_UPGRADE_REQUIRED",
            hint: "This launcher cannot prepare and validate the candidate before stopping Coach. Nothing was stopped or applied. Replace the stable launcher with a reviewed current build using the same Coach home.",
          });
        let prepared = false;
        if (updates.snapshot().preparationSupported) {
          try {
            await updates.prepare(body.sha);
            prepared = true;
            updates.validatePrepared(body.sha);
          } catch (error: any) {
            await updates.cancelPreparation(body.sha).catch(() => {});
            return send(
              error?.message === "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"
                ? 409
                : 503,
              {
                error:
                  error?.message === "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED"
                    ? error.message
                    : "UPDATE_PREPARATION_FAILED",
                hint: "Candidate preparation failed while Coach remained available. Provision the exact trusted native artifact or inspect source/build prerequisites, then retry.",
              },
            );
          }
        }
        const cancelPrepared = async () => {
          if (prepared)
            await updates.cancelPreparation(body.sha).catch(() => {});
          prepared = false;
        };
        // Preparation can be slow. Recheck every mutable admission condition
        // before fencing claims or stopping a running worker.
        if (autoQuiesced || busy || preview || updates.recovering) {
          await cancelPrepared();
          return send(409, {
            error: "OPERATION_IN_PROGRESS",
            hint: "Finish or cancel the other operation, then retry the upgrade.",
          });
        }
        // Reject before native teardown or irreversible Worker.stop().
        if (
          worker &&
          (!worker.safeToReplace || (!wasRunning && !worker.stopConfirmed))
        ) {
          await cancelPrepared();
          return send(409, { error: "WORKER_STOP_UNCONFIRMED" });
        }
        if (wasRunning && !updates.snapshot().manualRestartSupported) {
          await cancelPrepared();
          return send(409, {
            error: "LAUNCHER_UPGRADE_REQUIRED",
            hint: "This older launcher cannot preserve running Coach across a manual update. Nothing was stopped or applied. Replace the stable launcher with a reviewed current build using the same Coach home; settings and preview restarts do not need this upgrade.",
          });
        }
        // The confirmed upgrade closes Pi after the candidate is prepared.
        // busy fences new native tickets before teardown; stop closes the
        // gateway and reconciles its action journal before owner acceptance.
        if (wasRunning && !worker!.quiesceForUpdate()) {
          await cancelPrepared();
          return send(409, { error: "AUTO_UPDATE_BUSY" });
        }
        busy = true;
        try {
          await terminal.stop();
          if (!terminal.idle) throw new Error("WORKER_STOP_UNCONFIRMED");
          if (wasRunning) await worker!.stop();
          if (worker && (!worker.stopConfirmed || !worker.safeToReplace))
            throw new SafeError("WORKER_STOP_UNCONFIRMED");
          void updates.apply(body.sha, wasRunning).catch(() => {});
          prepared = false;
          await updates.accepted;
        } catch (error) {
          await cancelPrepared();
          if (
            wasRunning &&
            !updates.applying &&
            worker?.presence !== "unconfirmed" &&
            worker?.safeToReplace
          )
            await startWorker().catch(() => {});
          if (error instanceof SafeError)
            return send(400, { error: error.code, hint: error.hint });
          return send(503, {
            error: "UPDATE_NOT_ACCEPTED",
            hint: "Could not persist the update request. Check protected home storage.",
          });
        } finally {
          worker?.releaseUpdateQuiesce();
          busy = false;
        }
        return send(202, { ok: true });
      }
      if (path === "/api/shutdown" && onShutdown) {
        await terminal.stop();
        preview?.abort();
        send(200, { ok: true });
        setImmediate(onShutdown);
        return;
      }
      if (path === "/api/cancel") {
        preview?.abort();
        return send(200, { ok: true });
      }
      if (path === "/api/preview") {
        previewRequest = true;
        if (
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 8000
        )
          throw new Error("INVALID_PREVIEW");
        // Admission is synchronous with the busy, update, quiesce and
        // configuration checks above: no mutation can interleave. The worker
        // and native sessions are neither consulted nor touched; a legacy
        // confirmRestart is accepted and ignored. Shutdown may have begun
        // while the body was read.
        if (closing) return send(503, { error: "SERVICE_CLOSING" });
        if (preview)
          return send(409, {
            error: "OPERATION_IN_PROGRESS",
            hint: "A preview is already running. Wait for it or cancel it.",
          });
        // A client that left during the body read already fired "close".
        if (res.destroyed || req.socket.destroyed)
          throw new SafeError("CANCELLED");
        const controller = (preview = new AbortController());
        let settled!: () => void;
        previewDone = new Promise<void>((resolve) => {
          settled = resolve;
        });
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          logs.record({ source: "studio", stage: "preview-started", ref });
          // Capture the saved endpoint, model, credentials and redaction set
          // together; nothing below rereads mutable configuration.
          const c = store.publicConfig();
          const token = store.secrets.token;
          const apiKey = store.secrets.apiKey;
          const secrets = Object.values(store.secrets);
          const system = compile(c, secrets);
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60000),
          ]);
          // Cancel, disconnect, shutdown and the deadline release the single
          // preview slot even if a provider or backend ignores the signal.
          // Well-behaved work settles (and logs) itself within the grace.
          const bounded = <T>(work: Promise<T>) =>
            new Promise<T>((resolve, reject) => {
              let grace: NodeJS.Timeout | undefined;
              const stop = () => {
                grace = setTimeout(
                  () =>
                    reject(
                      new SafeError(
                        !controller.signal.aborted &&
                        signal.reason?.name === "TimeoutError"
                          ? "PROVIDER_TIMEOUT"
                          : "CANCELLED",
                      ),
                    ),
                  1000,
                );
              };
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
              work.then(resolve, reject).finally(() => {
                clearTimeout(grace);
                signal.removeEventListener("abort", stop);
              });
            });
          const instructions = await bounded(
            fetchInstructions(
              new Client(c.origin, token, signal, onBackendDiagnostic),
            ),
          ).catch(() => {
            if (controller.signal.aborted) throw new SafeError("CANCELLED");
            throw new Error("BACKEND_INSTRUCTIONS_UNAVAILABLE");
          });
          const prompt = effectivePrompt(system, instructions, secrets);
          const text = await bounded(
            infer(
              {
                ...c.provider,
                onDiagnostic: (event) => logs.record({ ...event, ref }),
                apiKey,
                secrets,
              },
              prompt,
              body.text,
              signal,
            ),
          );
          // Cancel, disconnect, the deadline, shutdown, an update lock or a
          // changed saved revision/credential all fence output that arrives late.
          if (
            signal.aborted ||
            closing ||
            updates.applying ||
            updates.recovering ||
            autoQuiesced ||
            configurationUncertain ||
            store.publicConfig().revision !== c.revision ||
            store.secrets.token !== token ||
            store.secrets.apiKey !== apiKey
          )
            throw new SafeError("CANCELLED");
          for (const secret of new Set([
            ...secrets,
            ...Object.values(store.secrets),
          ]))
            if (secret && text.includes(secret))
              throw new Error("OUTPUT_REJECTED");
          logs.record({ source: "studio", stage: "preview-completed", ref });
          return send(200, {
            text,
            prompt,
            revision: c.revision,
            instructionsStatus: "fetched",
            configuration: "saved",
            dataAuthority: "none: preview has no claimed request or data tools",
          });
        } finally {
          res.removeListener("close", cancel);
          if (preview === controller) preview = undefined;
          settled();
        }
      }
      if (configuration && preview)
        return send(409, {
          error: "OPERATION_IN_PROGRESS",
          hint: "Finish or cancel the running preview, then save or restore again. Your draft is retained.",
        });
      if (busy) return send(409, { error: "OPERATION_IN_PROGRESS" });
      busy = true;
      if (configuration && operationId) acceptedId = operationId;
      try {
        if (
          ["/api/config", "/api/rollback", "/api/persona-restore"].includes(
            path,
          ) ||
          skillMutation
        ) {
          if (
            ((worker && worker.state !== "stopped") || terminal.active) &&
            confirmRestart !== true
          )
            return send(409, {
              error: "RESTART_CONFIRMATION_REQUIRED",
              hint: "Confirm to stop Coach, apply this change and restart it if it was running. Native sessions close; chat and actions are never replayed.",
            });
          await transition(path, { confirmRestart, operationId }, async () => {
            if (skillMutation) {
              const id = skillMutation[1];
              const restored = !!skillMutation[2];
              if (
                restored &&
                (!body || Array.isArray(body) || Object.keys(body).length !== 0)
              )
                throw new Error("INVALID_SKILL");
              const result = restored
                ? await store.skills.restoreDefault(id, expectedRevision)
                : await store.skills.save(id, body, expectedRevision);
              logs.record({
                source: "studio",
                stage: "skills-revision-saved",
                metadata: {
                  skillRevision: result.revision,
                  enabledSkills: store.skills.runtime().skills.length,
                },
              });
            } else if (path === "/api/config") {
              // Every incoming credential, including inactive and new registry
              // providers, must be absent from retained action receipts.
              // Retired chat archives are never loaded, served or rewritten.
              const secrets = [
                ...Object.values(store.secrets),
                ...[
                  body?.apiKey,
                  body?.token,
                  ...(Array.isArray(body?.models?.providers)
                    ? body.models.providers.map((p: any) => p?.apiKey)
                    : []),
                ].filter((v): v is string => typeof v === "string"),
              ];
              new Actions(store, onBackendDiagnostic).assertSecrets(secrets);
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
          });
          return send(
            200,
            skillMutation
              ? { ...store.skills.view(skillMutation[1]), lifecycle }
              : { ok: true, lifecycle },
          );
        }
        if (path === "/api/connect") {
          if (!store.secrets.token) throw new Error("TOKEN_REQUIRED");
          const c = new Client(
            store.publicConfig().origin,
            store.secrets.token,
            AbortSignal.timeout(10000),
            onBackendDiagnostic,
          );
          await c.connect();
          await c.call("coach_list_requests", { limit: 1 });
          return send(200, {
            ok: true,
            message:
              "Credential accepted. This is connectivity, not a completed Coach reply.",
          });
        }
        if (path === "/api/run" || path === "/api/update/resume") {
          await startWorker();
          if (lifecycle?.error === "COACH_RESTART_FAILED") {
            lifecycle.resumed = true;
            delete lifecycle.error;
            delete lifecycle.hint;
          }
          return send(200, { ok: true, presence: worker!.presence });
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
      const memory = memoryError(e);
      if (memory) return send(memory.status, memory.body);
      if ((e as Error)?.message === "NATIVE_HISTORY_BUSY")
        return send(409, {
          error: "NATIVE_HISTORY_BUSY",
          hint: "Stop Pi explicitly before selecting, creating or deleting a conversation.",
        });
      const failure = safeError(e);
      logs.record({
        source: "studio",
        stage: failure.code === "CANCELLED" ? "cancelled" : "operation-failed",
        level: failure.code === "CANCELLED" ? "warn" : "error",
        ref,
        metadata: { elapsedMs: Date.now() - started },
        error: failure,
      });
      send(400, {
        error: failure.code,
        hint: failure.hint,
        metadata: failure.metadata,
        ...(previewRequest ? {} : { lifecycle }),
      });
    }
  });
  const terminal = new NativeTerminal(
    store,
    server,
    () => origin,
    () =>
      !closing &&
      !busy &&
      !configurationUncertain &&
      !updates.applying &&
      !updates.recovering &&
      !autoQuiesced,
    onBackendDiagnostic,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    async close() {
      closing = true;
      preview?.abort();
      await lifecycleDone;
      await previewDone;
      await terminal.close();
      for (const controller of memberReads) controller.abort();
      preview?.abort();
      await worker?.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
