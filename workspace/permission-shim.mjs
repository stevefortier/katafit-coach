// Preloaded with --import. Under Node's permission model, existsSync throws
// ERR_ACCESS_DENIED for paths outside the grant instead of returning false.
// Pi probes ancestor folders for project resources, so a denied path must
// simply look absent. Nothing is granted: the read is still refused.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const existsSync = fs.existsSync;
fs.existsSync = (path) => {
  try {
    return existsSync(path);
  } catch (error) {
    if (error?.code === "ERR_ACCESS_DENIED") return false;
    throw error;
  }
};
syncBuiltinESMExports();
