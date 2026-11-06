import type { Readable, Writable } from "node:stream";
import type { NativeGateway } from "./gateway.js";
import {
  NATIVE_REQUEST_FRAME_LIMIT,
  NATIVE_RESPONSE_FRAME_LIMIT,
  failureFrame,
} from "./failures.js";

// Host side of the relay protocol, shared by every sandbox runtime. The relay
// runs inside the sandbox and is untrusted: frames are bounded and validated,
// requests go to the gateway, and any protocol violation calls fail(), which
// tears the session down.
export const record = (value: any) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function validFrame(frame: any): boolean {
  if (!record(frame)) return false;
  const keys = Object.keys(frame);
  if (keys.length === 1 && keys[0] === "delivered")
    return Number.isSafeInteger(frame.delivered) && frame.delivered > 0;
  if (keys.length === 1 && keys[0] === "cancel")
    return Number.isSafeInteger(frame.cancel) && frame.cancel > 0;
  if (
    keys.length !== 2 ||
    !keys.includes("id") ||
    !keys.includes("request") ||
    !Number.isSafeInteger(frame.id) ||
    frame.id < 1 ||
    !record(frame.request)
  )
    return false;
  const request = frame.request,
    fields = Object.keys(request);
  if (request.kind === "catalog") return fields.length === 1;
  if (request.kind === "provider")
    return (
      fields.length === 2 && fields.includes("body") && record(request.body)
    );
  return (
    request.kind === "tool" &&
    (fields.length === 3 || fields.length === 4) &&
    fields.includes("name") &&
    fields.includes("args") &&
    (fields.length === 3 || fields.includes("toolCallId")) &&
    typeof request.name === "string" &&
    request.name.length > 0 &&
    request.name.length <= 256 &&
    record(request.args) &&
    (fields.length === 3 ||
      (typeof request.toolCallId === "string" &&
        request.toolCallId.length > 0 &&
        request.toolCallId.length <= 256))
  );
}

export interface RelayEndpoint {
  /** Frames from the relay. */
  input: Readable;
  /** Frames to the relay. */
  output: Writable;
  /** In-flight gateway requests by frame id; the runtime aborts them on stop. */
  requests: Map<number, AbortController>;
  gateway: () => NativeGateway | undefined;
  closing: () => boolean;
  fail: () => void;
}
export function serveRelay({
  input,
  output,
  requests,
  gateway,
  closing,
  fail,
}: RelayEndpoint) {
  // Byte-counted line framing over raw chunks: linear in frame size, and a
  // single request line may not exceed the relay's own request frame cap.
  let chunks: Buffer[] = [];
  let buffered = 0;
  let pending = 0,
    lastId = 0;
  // At most one final reply awaits the relay's delivery acknowledgement.
  const deliveries = new Map<number, string>();
  const respond = (response: any) => {
    let data = JSON.stringify(response) + "\n";
    // An oversized result is withheld as a fixed code, not a teardown.
    if (Buffer.byteLength(data) > NATIVE_RESPONSE_FRAME_LIMIT)
      data =
        JSON.stringify({
          id: response.id,
          error: "NATIVE_RESULT_TOO_LARGE",
        }) + "\n";
    if (
      output.destroyed ||
      output.writableLength > 2 * NATIVE_RESPONSE_FRAME_LIMIT
    ) {
      fail();
      return;
    }
    const completion = response.result?.completion_id;
    if (
      typeof completion === "string" &&
      Buffer.byteLength(data) <= NATIVE_RESPONSE_FRAME_LIMIT
    ) {
      deliveries.clear();
      deliveries.set(response.id, completion);
    }
    output.write(data);
  };
  const accept = (line: string) => {
    let frame: any;
    try {
      frame = JSON.parse(line);
      if (!validFrame(frame)) throw new Error("FRAME_REJECTED");
    } catch {
      fail();
      return false;
    }

    if (Number.isSafeInteger(frame.delivered)) {
      const completion = deliveries.get(frame.delivered);
      deliveries.delete(frame.delivered);
      if (completion) gateway()?.confirmDelivery?.(completion);
      return true;
    }
    if (Number.isSafeInteger(frame.cancel)) {
      requests.get(frame.cancel)?.abort();
      return true;
    }
    if (
      ++pending > 4 ||
      !Number.isSafeInteger(frame.id) ||
      frame.id <= lastId
    ) {
      fail();
      return false;
    }
    lastId = frame.id;
    const controller = new AbortController();
    requests.set(frame.id, controller);
    void Promise.resolve()
      .then(() => {
        if (closing()) throw new Error("NATIVE_CLOSED");
        return gateway()!.handle(frame.request, controller.signal);
      })
      .then(
        (result) => ({ id: frame.id, result }),
        (error) => ({
          id: frame.id,
          ...failureFrame(error, frame.request?.kind),
        }),
      )
      .then((response) => {
        pending--;
        requests.delete(frame.id);
        respond(response);
      })
      .catch(() => {
        fail();
      });
    return true;
  };
  input.on("data", (data: Buffer | string) => {
    if (closing()) return;
    try {
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      let start = 0,
        end;
      while ((end = chunk.indexOf(10, start)) >= 0) {
        if (buffered + end - start > NATIVE_REQUEST_FRAME_LIMIT) {
          fail();
          return;
        }
        chunks.push(chunk.subarray(start, end));
        const line = Buffer.concat(chunks).toString("utf8");
        chunks = [];
        buffered = 0;
        start = end + 1;
        if (!accept(line)) return;
      }
      if (start < chunk.length) {
        buffered += chunk.length - start;
        if (buffered > NATIVE_REQUEST_FRAME_LIMIT) {
          fail();
          return;
        }
        chunks.push(chunk.subarray(start));
      }
    } catch {
      fail();
    }
  });
  output.on("error", () => {
    fail();
  });
}
