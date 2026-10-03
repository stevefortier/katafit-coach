/** Compiled stable-owner contract, independent of native sandbox protocol. */
export const manualOnlySourceUpdates = 1;

/**
 * Application capability declared in `dist/build.json` `capabilities`: the
 * build loads `<home>/autonomy/writes.json` at startup, reports unresolved
 * writes unsafe and never claims or dispatches while they remain.
 */
export const AUTONOMY_LEDGER_CAPABILITY = "autonomy-ledger-1";
