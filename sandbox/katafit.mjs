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
        if (!response.ok) {
          // Fixed read-only guidance, never backend prose or model arguments.
          // Keep uncertain-action protection for every other tool.
          const message =
            tool.name === "studio_operator_list_dojo_checkins"
              ? "Check-in listing failed. This does not establish that no photos exist. Image reads require references from a successful check-in listing; activity-detail metadata is not a substitute."
              : tool.name === "studio_operator_read_dojo_checkin_image"
                ? "Check-in image read failed; no image was delivered. Use the matching member_ref and media_ref from a successful check-in listing. Activity-detail media references are not sufficient. The per-turn quota is four images and 16 MiB total. Do not repeat the same failed call or claim to have inspected pixels."
                : "Kata.fit tool failed; do not replay uncertain actions.";
          throw new Error(message);
        }
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
