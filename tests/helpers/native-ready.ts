// Pi 0.86.1 InteractiveMode.init awaits fd/rg, installs submit handlers, then
// rebindCurrentSession binds extensions and emits this terminal title. The
// version header and host WebSocket "ready" frame precede that initialization.
// Match the complete OSC (including BEL), even when split over output frames.
export const PI_READY = "\u001b]0;π - workspace\u0007";

export async function waitForPiReady(output: () => string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!output().includes(PI_READY)) {
    if (Date.now() >= deadline)
      throw new Error("Pi startup title not received: " + output());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
