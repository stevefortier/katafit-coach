/** Compiled stable-owner contract, independent of native sandbox protocol. */
export const manualOnlySourceUpdates = 1;
/** Token-bound preparation/admin IPC; unrelated to native artifact protocol. */
export const updatePreparationProtocol = 2;

/**
 * Application capability declared in `dist/build.json` `capabilities`: the
 * build loads `<home>/autonomy/writes.json` at startup, reports unresolved
 * writes unsafe and refuses new claims/actions until read-only exact settlement.
 * An already admitted cycle may dispatch at most one same-work/generation
 * terminal blocked/uncertain_write completion without certifying new actions;
 * that exception never clears or replays the original unresolved write.
 * Already dispatched operations drain normally and retain unknown outcomes.
 */
export const AUTONOMY_LEDGER_CAPABILITY = "autonomy-ledger-1";
