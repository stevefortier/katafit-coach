// Idle-deadline observer for the negotiated streamed-JSON Operator endpoint.
// No invented async operation IDs or replay on timeout. Heartbeats count only
// when received as actual HTTP bytes. Intended to catch the 75s proxy failure.
export async function streamedTurn(
  url,
  headers,
  text,
  { idleMs = 75000, totalMs = 120000 } = {},
) {
  const controller = new AbortController(),
    start = Date.now();
  let idle;
  const reset = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error("HTTP idle deadline exceeded")),
      idleMs,
    );
  };
  const total = setTimeout(
    () => controller.abort(new Error("HTTP total deadline exceeded")),
    totalMs,
  );
  const chunks = [];
  let response,
    raw = "";
  reset();
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, Accept: "application/vnd.katafit.operator+json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const bytes of response.body) {
      reset();
      chunks.push({ elapsedMs: Date.now() - start, bytes: bytes.length });
      raw += decoder.decode(bytes, { stream: true });
    }
    raw += decoder.decode();
    return {
      status: response.status,
      body: JSON.parse(raw),
      transport: {
        elapsedMs: Date.now() - start,
        chunks,
        contentType: response.headers.get("content-type"),
      },
    };
  } catch (error) {
    error.transport = {
      elapsedMs: Date.now() - start,
      chunks,
      status: response?.status,
    };
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}
