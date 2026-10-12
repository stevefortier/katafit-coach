/** Deadlines reject missing events; elapsed time never qualifies readiness. */
export async function requestBoundary<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Exact-event request boundary was not reached")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Observe the real fetch/JSON result without replacing its status or body.
 * selectEvent's denial and stale-success paths finish in promise microtasks
 * after headers/JSON respectively. A MessageChannel task runs after that
 * microtask checkpoint, including dashboardFetch/read/selectEvent continuations.
 */
export async function observeExactEventRead(page: any, eventId: string) {
  await page.evaluate((eventId: string) => {
    const original = window.fetch;
    const channel = new MessageChannel();
    const trace: string[] = [];
    let resolve!: (result: unknown) => void;
    const finished = new Promise((done) => {
      resolve = done;
    });
    const restore = () => {
      window.fetch = original;
      channel.port1.close();
      channel.port2.close();
    };
    channel.port1.onmessage = (event) => {
      trace.push("response-continuations-drained");
      restore();
      resolve({ ...event.data, trace });
    };
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = new URL(response.url);
      if (
        url.pathname === "/api/dashboard/event" &&
        url.searchParams.get("event_id") === eventId
      ) {
        trace.push("native-response-headers");
        const result = { url: response.url, status: response.status };
        if (!response.ok) channel.port2.postMessage(result);
        else {
          const json = response.json.bind(response);
          response.json = async () => {
            const body = await json();
            trace.push("native-response-json");
            channel.port2.postMessage(result);
            return body;
          };
        }
      }
      return response;
    };
    (window as any).exactEventReadProbe = { finished, restore };
  }, eventId);
}
