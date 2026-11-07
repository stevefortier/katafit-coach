// Pi's supported autocomplete wrapper, backed by the same virtual filesystem
// as workspace tools. Never delegate file lookup to Pi's host-backed provider.
import { posix } from "node:path";
import { workspaceShell } from "./tools.mjs";

export function workspaceAutocomplete(current, fs) {
  const token = (lines, row, col) =>
    (lines[row] ?? "").slice(0, col).match(/(?:^|\s)(@?"[^"]*|[^\s]*)$/)?.[1] ??
    "";
  return {
    triggerCharacters: ["@", "/", "."],
    shouldTriggerFileCompletion() {
      // Pi gates forced requests (including Tab) here, not ordinary typing.
      // Let getSuggestions enforce nonforced prose and virtual-root boundaries.
      return true;
    },
    applyCompletion: current.applyCompletion.bind(current),
    async getSuggestions(lines, row, col, options) {
      const text = (lines[row] ?? "").slice(0, col);
      const prefix = token(lines, row, col);
      // Non-forced slash completion only handles registered commands/arguments
      // in Pi 0.86.1, except @ attachments, which Pi checks before commands.
      if (
        text.startsWith("/") &&
        !text.startsWith("/workspace/") &&
        !text.includes("@")
      ) {
        return current.getSuggestions(lines, row, col, {
          ...options,
          force: false,
        });
      }
      if (!options.force && !prefix.startsWith("@") && !prefix.includes("/"))
        return null;
      const attachment = prefix.startsWith("@");
      const raw = prefix.slice(attachment ? 1 : 0).replace(/^"/, "");
      const slash = raw.lastIndexOf("/");
      const directory = raw.slice(0, slash + 1);
      const query = raw.slice(slash + 1).toLowerCase();
      const root = posix.resolve("/workspace", directory || ".");
      if (root !== "/workspace" && !root.startsWith("/workspace/")) return null;
      const items = [];
      let visited = 0;
      const walk = async (folder, relative, recursive) => {
        if (options.signal?.aborted || visited >= 5000 || items.length >= 100)
          return;
        let names;
        try {
          names = await fs.readdir(folder);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          if (
            options.signal?.aborted ||
            ++visited > 5000 ||
            items.length >= 100
          )
            break;
          if (name === ".git") continue;
          const path = posix.join(folder, name);
          let stat;
          try {
            stat = await fs.lstat(path);
          } catch {
            continue;
          }
          if (stat.isSymbolicLink) continue;
          const display = relative + name + (stat.isDirectory ? "/" : "");
          if (
            name.toLowerCase().startsWith(query) ||
            (attachment && display.toLowerCase().includes(query))
          ) {
            const value = directory + display;
            const quoted = prefix.includes('"') || /\s/.test(value);
            items.push({
              label: display,
              value: (attachment ? "@" : "") + (quoted ? `"${value}"` : value),
            });
          }
          if (recursive && stat.isDirectory)
            await walk(path, relative + name + "/", true);
        }
      };
      await walk(root, "", attachment && slash < 0);
      return items.length ? { prefix, items } : null;
    },
  };
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const { fs } = workspaceShell(process.cwd());
    ctx.ui.addAutocompleteProvider((current) =>
      workspaceAutocomplete(current, fs),
    );
  });
}
