import { assertNoSecrets } from "../config/store.js";
import { SafeError } from "../runtime/errors.js";
import { prepareModelImage } from "./providerImage.js";

export const restGetTool = {
  name: "katafit_rest_get",
  description:
    "Primary tool for Kata.fit reads: call any ordinary /api/ GET route as the current user, including newly added routes without registration. Start /api/friends/feed/dojo?limit=20; follow hasMore/oldestDate with beforeDate. Fetch /api/friends/activity/:id for cross-member details and full data.files (feed files are previews), then /api/media/:id/files/:fileId for pixels. /api/activities/:id is owner-only. Use acquired data internally without permission refresh or source proofs; backend decides each new GET. No MCP read fallback on denial. Supply only a relative path with bounded query; no writes, custom headers or URLs. Execute reads sequentially.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 5, maxLength: 2048 } },
  },
};

/** This is not an endpoint catalogue: only transport syntax and resource bounds. */
export function restPath(args: unknown): string {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).join() !== "path" ||
    typeof (args as any).path !== "string"
  )
    throw new Error("REST_REQUEST_REJECTED");
  const path = (args as any).path as string;
  if (
    Buffer.byteLength(path) > 2048 ||
    !path.startsWith("/api/") ||
    /[\\#\u0000-\u001f\u007f]/.test(path) ||
    /%(?:2f|5c|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)
  )
    throw new Error("REST_REQUEST_REJECTED");
  const [pathname, ...queries] = path.split("?");
  if (
    queries.length > 1 ||
    pathname.length > 1024 ||
    (queries[0]?.length ?? 0) > 1024 ||
    pathname.split("/").some((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return true;
      }
      return (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        decoded.includes("%") ||
        /[\u0000-\u001f\u007f]/.test(decoded)
      );
    })
  )
    throw new Error("REST_REQUEST_REJECTED");
  if (queries.length) {
    // Decode each parameter once; never allow an encoded URL/control to be
    // interpreted as a second request or an injected header by downstream code.
    for (const [key, value] of new URLSearchParams(queries[0])) {
      if (
        !key ||
        key.length > 128 ||
        value.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(key + value)
      )
        throw new Error("REST_REQUEST_REJECTED");
    }
  }
  return path;
}

export const restRequestTool = {
  name: "katafit_rest_request",
  description:
    "Call ordinary Kata.fit HTTP APIs as the current account. First GET /api/docs/coach, then GET the relevant domain path from that index; follow documented methods, parameters and bodies, never guess routes. Backend authorizes every new request. Relative /api/ paths only; no caller headers or credentials. JSON bodies/results are bounded; validated images are supported. For shared photos use /api/friends/feed/dojo?type=media&limit=20&pagination=cursor; for body measurements plus photos use types=media,metric, not a media-only filter for broader activity questions. Choose type or types, never both. Use documented startDate/endDate; beforeDate is older-backend compatibility only with timestamp-tie/partial-coverage caveats. For filtered stable paging omit cursor initially, follow hasMore/nextCursor, then send pagination=cursor&cursor=<URL-encoded opaque nextCursor> with unchanged type/date filters, mode and limit; never mix or switch to beforeDate. Empty privacy-filtered pages may advance nextCursor even with null oldestDate. Select returned user_id locally, never invent member query filters. Acquire sequentially: pages, selected details via /api/friends/activity/:id ({activity,owner}, full activity.data.files), then chosen images via /api/media/:activityId/files/:fileId. Feed files are previews, not full inventory. Reuse acquired context and image bytes/receipts internally without permission refresh or refetching to send. Stop on missing/repeated/nonadvancing cursors and disclose partial coverage. Read before requested changes and read back canonical state afterwards. For an explicitly requested message to a current Dojo roster recipient, including the dojo chief, POST /api/coach/member-messages/:recipient_id with exactly {text}; the host supplies and verifies the delivery key, so never supply idempotency_key. A request-validation rejection is not evidence that the recipient is ineligible. Never replay uncertain mutations. See katafit-api skill.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["method", "path"],
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: { type: "string", minLength: 5, maxLength: 2048 },
      body: {
        description: "Optional JSON body for mutations only; at most 64 KiB.",
      },
    },
  },
};

export function restRequestArgs(args: unknown): {
  method: string;
  path: string;
  body?: string;
} {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !["method", "path", "body"].includes(key))
  )
    throw new Error("REST_REQUEST_REJECTED");
  const value = args as any;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value.method))
    throw new Error("REST_REQUEST_REJECTED");
  const path = restPath({ path: value.path });
  let body: string | undefined;
  if (Object.hasOwn(value, "body")) {
    if (value.method === "GET") throw new Error("REST_REQUEST_REJECTED");
    const visit = (entry: unknown, depth = 0): void => {
      if (depth > 32) throw new Error("REST_REQUEST_REJECTED");
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean"
      )
        return;
      if (typeof entry === "number" && Number.isFinite(entry)) return;
      if (Array.isArray(entry)) {
        for (const item of entry) visit(item, depth + 1);
        return;
      }
      if (
        entry &&
        typeof entry === "object" &&
        Object.getPrototypeOf(entry) === Object.prototype
      ) {
        for (const item of Object.values(entry)) visit(item, depth + 1);
        return;
      }
      throw new Error("REST_REQUEST_REJECTED");
    };
    visit(value.body);
    try {
      body = JSON.stringify(value.body);
    } catch {
      throw new Error("REST_REQUEST_REJECTED");
    }
    if (body === undefined || Buffer.byteLength(body) > 65536)
      throw new Error("REST_REQUEST_REJECTED");
  }
  return { method: value.method, path, body };
}

export async function restGet(
  origin: string,
  bearer: string,
  args: unknown,
  signal: AbortSignal,
  secrets: string[],
  maxJsonBytes: 262144 | 2097152 = 262144,
) {
  return restRequest(
    origin,
    bearer,
    { method: "GET", path: restPath(args) },
    signal,
    secrets,
    maxJsonBytes,
  );
}

export async function restRequest(
  origin: string,
  bearer: string,
  args: unknown,
  signal: AbortSignal,
  secrets: string[],
  maxJsonBytes: 262144 | 2097152 = 262144,
) {
  const { path, method, body } = restRequestArgs(args);
  if (
    ![262144, 2097152].includes(maxJsonBytes) ||
    (maxJsonBytes !== 262144 &&
      (method !== "GET" ||
        !/^\/api\/friends\/dojo\/member-stats\?user_id=[a-f0-9]{24}$/.test(
          path,
        )))
  )
    throw new Error("REST_REQUEST_REJECTED");
  assertNoSecrets(args, [...secrets, bearer]);
  if (!bearer || bearer.length > 4096 || /[\u0000-\u001f\u007f]/.test(bearer))
    throw new Error("REST_UNAVAILABLE");
  const base = new URL(origin);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    (base.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("REST_UNAVAILABLE");
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/"))
    throw new Error("REST_REQUEST_REJECTED");
  const deadline = AbortSignal.timeout(8000);
  const wireSignal = AbortSignal.any([signal, deadline]);
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method,
      body,
      redirect: "manual",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json, image/jpeg, image/png, image/webp",
      },
      signal: wireSignal,
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("REST_REDIRECT_REJECTED");
    if (!response.ok) {
      if (method !== "GET") throw new Error("REST_MUTATION_UNKNOWN");
      return { restReadError: { status: response.status } };
    }
    if (response.status === 204)
      return {
        content: [{ type: "text", text: JSON.stringify({ status: 204 }) }],
      };
    const mime = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    const image = ["image/jpeg", "image/png", "image/webp"].includes(
      mime ?? "",
    );
    if (!image && mime !== "application/json")
      throw new Error("REST_TYPE_REJECTED");
    const limit = image ? 4 * 1024 * 1024 : maxJsonBytes;
    const length = Number(response.headers.get("content-length"));
    if (length > limit) throw new Error("REST_RESULT_TOO_LARGE");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (total > limit) throw new Error("REST_RESULT_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (image) {
      const checked = await prepareModelImage(bytes, mime!);
      return {
        content: [
          { type: "text", text: "Kata.fit image read (validated pixels)." },
          {
            type: "image",
            mimeType: checked.mimeType,
            data: checked.data.toString("base64"),
          },
        ],
      };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
    assertNoSecrets(text, [...secrets, bearer]);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (method !== "GET") throw new Error("REST_MUTATION_UNKNOWN");
    if (wireSignal.aborted)
      throw new SafeError(
        wireSignal.reason?.name === "TimeoutError"
          ? "BACKEND_TIMEOUT"
          : "CANCELLED",
      );
    if (error instanceof TypeError) throw new SafeError("CONNECTIVITY_ERROR");
    throw error;
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}
