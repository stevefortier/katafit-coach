// These regressions explicitly exercise retained backend-history compatibility,
// not the default ordinary-REST conversation. New REST tests import the gateway
// directly and assert zero legacy acquisition/continuity calls.
import {
  openNativeGateway as open,
  type NativeGatewayHooks,
} from "../../src/sandbox/gateway.js";
import type { Store } from "../../src/config/store.js";
export * from "../../src/sandbox/gateway.js";
export function openNativeGateway(
  store: Store,
  signal?: AbortSignal,
  hooks: NativeGatewayHooks = {},
) {
  return open(store, signal, { ...hooks, backendHistory: true });
}
