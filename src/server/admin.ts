import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { Store, compile } from "../config/store.js";
import { complete } from "../runtime/piAdapter.js";
import { Worker } from "../worker/runner.js";
import { Client } from "../katafit/client.js";
import { effectivePrompt, fetchInstructions } from "../runtime/prompt.js";
export async function admin(
  store: Store,
  port = 4317,
  infer = complete,
  onShutdown?: () => void,
) {
  let worker: Worker | undefined;
  let preview: AbortController | undefined;
  let busy = false;
  let origin = "";
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: "HOST_REJECTED" });
      const path = req.url ?? "/";
      if (
        ["/", "/app.js", "/style.css"].includes(path) &&
        req.method === "GET"
      ) {
        const file = path === "/" ? "index.html" : path.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
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
      if (req.method === "GET" && path === "/api/config")
        return send(200, {
          ...store.publicConfig(),
          hasToken: !!store.secrets.token,
          hasApiKey: !!store.secrets.apiKey,
        });
      if (req.method === "GET" && path === "/api/status")
        return send(200, {
          state: worker?.state ?? "stopped",
          preview: !!preview,
          revision: store.publicConfig().revision,
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
      if (path === "/api/shutdown" && onShutdown) {
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
        if (path === "/api/config" || path === "/api/rollback") {
          if (worker && worker.state !== "stopped")
            return send(409, { error: "STOP_WORKER_BEFORE_CONFIGURE" });
          if (path === "/api/config") await store.save(body);
          else await store.rollback();
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
              throw new Error("BACKEND_INSTRUCTIONS_UNAVAILABLE");
            });
            const prompt = effectivePrompt(
              compile(c, Object.values(store.secrets)),
              instructions,
              Object.values(store.secrets),
            );
            const text = await infer(
              { ...c.provider, apiKey: store.secrets.apiKey },
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
              complete: (context, signal, system, tools) =>
                infer(
                  { ...c.provider, apiKey: store.secrets.apiKey },
                  system,
                  context,
                  signal,
                  tools,
                ),
            });
            worker.start();
          }
          return send(200, { ok: true });
        }
        if (path === "/api/stop") {
          await worker?.stop();
          return send(200, { ok: true });
        }
        return send(404, { error: "NOT_FOUND" });
      } finally {
        busy = false;
      }
    } catch (e: any) {
      const allowed = [
        "INVALID_CONFIG",
        "INVALID_PERSONA",
        "INVALID_URL",
        "TOKEN_REQUIRED",
        "CREDENTIAL_REJECTED",
        "CONNECTION_AND_PROVIDER_REQUIRED",
        "STOP_WORKER_BEFORE_PREVIEW",
        "PROVIDER_KEY_REQUIRED",
        "NO_PREVIOUS_REVISION",
        "BACKEND_INSTRUCTIONS_UNAVAILABLE",
        "SECRET_IN_CONFIG",
      ];
      send(400, {
        error: allowed.includes(e.message) ? e.message : "REQUEST_FAILED",
        hint:
          e.message === "BACKEND_INSTRUCTIONS_UNAVAILABLE"
            ? "Exact preview unavailable: backend instructions could not be fetched or validated. No inference ran. Check the saved Kata.fit origin."
            : "Check connection, provider key/model and endpoint. No raw provider errors are logged.",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    origin,
    async close() {
      preview?.abort();
      await worker?.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
