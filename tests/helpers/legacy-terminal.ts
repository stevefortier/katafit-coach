import { NativeTerminal as Terminal } from "../../src/server/terminal.js";
import { openNativeGateway } from "./legacy-gateway.js";
export class NativeTerminal extends Terminal {
  protected openGateway(...args: Parameters<typeof openNativeGateway>) {
    return openNativeGateway(...args);
  }
}
