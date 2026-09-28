import { assertNoSecrets } from "../config/store.js";
import { prepareModelImage } from "./providerImage.js";

export const restGetTool = {
  name: "katafit_rest_get",
  description:
    "Read any ordinary Kata.fit /api/ GET route under the configured origin as the current user. Supply only a relative absolute path and optional bounded query; no writes, custom headers or URLs. Backend user permissions decide access.",
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

export async function restGet(
  origin: string,
  bearer: string,
  args: unknown,
  signal: AbortSignal,
  secrets: string[],
) {
  const path = restPath(args);
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
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json, image/jpeg, image/png, image/webp",
    },
    signal: AbortSignal.any([signal, deadline]),
  });
  try {
    if (response.status >= 300 && response.status < 400)
      throw new Error("REST_REDIRECT_REJECTED");
    if (!response.ok) return { restReadError: { status: response.status } };
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
    const limit = image ? 4 * 1024 * 1024 : 256 * 1024;
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
    assertNoSecrets(text, secrets);
    return { content: [{ type: "text", text }] };
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
