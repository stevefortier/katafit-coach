import { readFileSync } from "node:fs";
export default function (pi) {
  const config = JSON.parse(readFileSync("/tmp/native-config.json", "utf8"));
  for (const tool of config.tools)
    pi.registerTool({
      ...tool,
      label: tool.name,
      async execute(_id, args, signal) {
        const response = await fetch("http://127.0.0.1:4318/tool", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: tool.name, args }),
          signal,
        });
        if (!response.ok)
          throw new Error(
            "Kata.fit tool failed; do not replay uncertain actions.",
          );
        return response.json();
      },
    });
  pi.registerCommand("mcp", {
    description: "Show negotiated Kata.fit MCP tools",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Kata.fit MCP — scoped to current Coach: " +
          config.tools.map((t) => t.name).join(", "),
        "info",
      );
    },
  });
}
