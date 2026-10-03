import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { managedFile } from "../update/managed.js";
import {
  durableDirectory,
  LEDGER_DIR,
  syncDirectory,
  type SyncDirectory,
} from "./ledger.js";

const FILE = "owner.json";
const OWNER = /^[a-f0-9]{32}$/;

/**
 * This installation's durable autonomy owner token: binds ledger entries and
 * labels every headless container so cleanup never crosses installations.
 */
export async function autonomyOwner(
  home: string,
  sync: SyncDirectory = syncDirectory,
): Promise<string> {
  const folder = join(home, LEDGER_DIR);
  await durableDirectory(folder, sync, true);
  const path = join(folder, FILE);
  try {
    const value = JSON.parse((await managedFile(path, 256)).toString("utf8"));
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "owner,v" ||
      value.v !== 1 ||
      !OWNER.test(value.owner)
    )
      throw new Error("AUTONOMY_OWNER_INVALID");
    return value.owner;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("AUTONOMY_OWNER_INVALID");
  }
  const owner = randomBytes(16).toString("hex");
  const temporary = join(
    folder,
    `${FILE}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: 1, owner }) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link() refuses to replace: a concurrent first start keeps one owner.
    try {
      await link(temporary, path);
    } catch (error: any) {
      if (error?.code === "EEXIST") return autonomyOwner(home, sync);
      throw error;
    }
    await sync(folder);
    return owner;
  } finally {
    await rm(temporary, { force: true });
  }
}
