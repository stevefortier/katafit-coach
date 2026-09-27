import { readFileSync } from "node:fs";
// Import-free and process-optional on purpose: the extension also runs in a
// bare vm context in tests. Container defaults: /tmp and port 4318.
const env = globalThis.process?.env ?? {};
const port = /^[1-9][0-9]{3,4}$/.test(env.KATAFIT_RELAY_PORT ?? "")
  ? Number(env.KATAFIT_RELAY_PORT)
  : 4318;
const configPath =
  (env.TMPDIR || "/tmp").replace(/\/+$/, "") + "/native-config.json";
// Relay failure codes the host allowlists with tool-specific recovery; all
// other failures keep the fixed per-tool fallback below.
const relayGuidance = {
  NATIVE_REQUEST_BUSY:
    "Another native request is still pending. This call was not dispatched and consumed nothing. Wait for the pending call to finish, then call again sequentially; do not send parallel calls.",
  NATIVE_TEXT_TOO_LARGE:
    "The tool arguments are over the native 1 MiB budget. This call was not dispatched; send smaller arguments.",
  NATIVE_REQUEST_REJECTED:
    "The tool request was rejected and not dispatched. Correct the arguments to match the advertised schema.",
  NATIVE_SESSION_EXPIRED:
    "This native Coach session has ended. The outcome of any in-flight action is unknown; check canonical Kata.fit state from a new native session before acting.",
  NATIVE_SESSION_REVOKED:
    "This native Coach session is no longer authorized and is closing. The outcome of any in-flight action is unknown; check canonical Kata.fit state from a new native session before acting.",
  NATIVE_RESULT_TOO_LARGE:
    "The tool result was over the native return budget and was withheld. If this was an action, its outcome is unknown; do not replay it.",
};
export default function (pi) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const tool of config.tools)
    pi.registerTool({
      ...tool,
      label: tool.name,
      async execute(_id, args, signal) {
        const response = await fetch(`http://127.0.0.1:${port}/tool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: tool.name, args }),
          signal,
        });
        // Unknown/transport failures stay fixed; never render backend prose.
        const fallback =
          tool.name === "studio_operator_list_dojo_checkins"
            ? "Check-in listing failed. This does not establish that no photos exist. Image reads require references from a successful check-in listing; activity-detail metadata is not a substitute."
            : tool.name === "studio_operator_read_dojo_checkin_image"
              ? "Check-in image read failed; no image was delivered. Use the matching member_ref and media_ref from a successful check-in listing. Activity-detail media references are not sufficient. The per-turn quota is four images and 16 MiB total. Do not repeat the same failed call or claim to have inspected pixels."
              : tool.name === "send_to_operator"
                ? "Sending to the operator failed. Nothing was added to the operator panel; do not claim the operator received or saw it."
                : "Kata.fit tool failed; do not replay uncertain actions.";
        if (!response.ok) {
          let code;
          try {
            code = (await response.json())?.error?.code;
          } catch {}
          throw new Error(
            typeof code === "string" && Object.hasOwn(relayGuidance, code)
              ? `${code}: ${relayGuidance[code]}`
              : fallback,
          );
        }
        const result = await response.json();
        if (tool.name === "send_to_operator" && result?.attachmentError) {
          const error = result.attachmentError;
          const guidance = {
            ATTACHMENT_ARGUMENTS_REJECTED:
              "Arguments did not match the schema. Supply exactly one of image_receipt or workspace_path, plus optional filename and caption, and nothing else.",
            ATTACHMENT_RECEIPT_UNKNOWN:
              "That image_receipt is not known to this session. Copy the exact image_receipt from a successful check-in image read in this session; receipts cannot be invented or reused across sessions.",
            ATTACHMENT_PATH_REJECTED:
              "workspace_path must be a relative path (or /workspace/...) to a regular file inside /workspace, without '.' or '..' components, control characters, or symbolic links; at most 8 components.",
            ATTACHMENT_FILE_NOT_FOUND:
              "No regular file exists at that path inside /workspace. Create or locate the file under /workspace first.",
            ATTACHMENT_FILE_UNAVAILABLE:
              "The file could not be read safely: it may be a symlink, directory, device, pipe, or was changed during reading. Only regular files inside /workspace can be sent.",
            ATTACHMENT_FILE_EMPTY:
              "The file is empty. Write its content first, then send it.",
            ATTACHMENT_TOO_LARGE:
              "The file exceeds the 8 MiB per-attachment limit. Send a smaller or compressed file.",
            ATTACHMENT_BUDGET_EXHAUSTED:
              "The operator panel is full for this session (16 attachments / 32 MiB). Tell the operator what could not be attached; do not reset the session to bypass limits.",
            ATTACHMENT_REJECTED:
              "The content, filename or caption was refused because it would disclose a configured credential. Do not attempt to send secrets.",
            ATTACHMENT_UNAVAILABLE:
              "The operator panel is not available for this session. Continue without attaching and tell the operator the attachment could not be delivered.",
          };
          if (
            Object.keys(result).join() === "attachmentError" &&
            error &&
            typeof error === "object" &&
            Object.keys(error).join() === "code" &&
            error.code === "ATTACHMENT_BUSY"
          )
            throw new Error(
              "ATTACHMENT_BUSY: Another native request is still pending. This send was not dispatched and nothing was added to the operator panel. Wait for the pending call to finish, then retry this send sequentially if still needed.",
            );
          if (
            Object.keys(result).join() !== "attachmentError" ||
            !error ||
            typeof error !== "object" ||
            Object.keys(error).join() !== "code" ||
            typeof error.code !== "string" ||
            !Object.hasOwn(guidance, error.code)
          )
            throw new Error(fallback);
          throw new Error(
            `${error.code}: ${guidance[error.code]} Nothing was added to the operator panel by this call; do not claim the operator received it. Do not repeat the unchanged failed call.`,
          );
        }
        if (result?.imageReadError) {
          const error = result.imageReadError;
          if (
            tool.name === "studio_operator_read_dojo_checkin_image" &&
            Object.keys(result).join() === "imageReadError" &&
            Object.keys(error).join() === "code" &&
            error.code === "IMAGE_READ_BUSY"
          )
            throw new Error(
              "IMAGE_READ_BUSY: Another native request is still pending. This image read was not dispatched; no image capacity was consumed by this attempt and no image was delivered. Wait for the pending call to finish, inspect its receipt and remaining capacity, then retry this read sequentially if still needed and within budget. Capacity is not reported while a call is pending. Do not send parallel reads or reset a session to bypass quotas.",
            );
          const guidance = {
            CHECKIN_LIST_REQUIRED:
              "First call studio_operator_list_dojo_checkins successfully, then copy the exact matching member_ref and media_ref from one shared row. Activity-detail media references and member roster entries are not sufficient.",
            IMAGE_ARGUMENTS_REJECTED:
              "Correct the arguments to match the advertised schema; supply the exact listed member_ref and media_ref pair, without host-owned fields.",
            IMAGE_BUDGET_EXHAUSTED:
              "Image delivery budget exceeded (4 images / 16 MiB per turn; 8 MiB per image). Use already delivered images and state the uninspected coverage. Only select a different listed image if it fits the remaining capacity. Never reset or reopen a session to bypass quotas.",
            IMAGE_TOOL_BUDGET_EXHAUSTED:
              "Tool-call budget exhausted for this turn even if image capacity remains. Stop reads and synthesize from successful receipts; do not reset or reopen a session to bypass quotas.",
            IMAGE_BACKEND_FAILED:
              "Backend did not deliver an authorized image. Access or availability could not be established; this does not prove no photo exists or sharing is disabled. State the gap; do not bypass authorization.",
            IMAGE_RESULT_REJECTED:
              "Returned image failed integrity or format validation and was not delivered. Do not inspect rejected bytes; use other verified evidence and report the gap.",
          };
          if (
            tool.name !== "studio_operator_read_dojo_checkin_image" ||
            Object.keys(result).join() !== "imageReadError" ||
            Object.keys(error).sort().join() !==
              "code,remainingBytes,remainingImages" ||
            !Object.hasOwn(guidance, error.code) ||
            !Number.isInteger(error.remainingImages) ||
            error.remainingImages < 0 ||
            error.remainingImages > 4 ||
            !Number.isInteger(error.remainingBytes) ||
            error.remainingBytes < 0 ||
            error.remainingBytes > 16 * 1024 * 1024
          )
            throw new Error(fallback);
          throw new Error(
            `${error.code}: ${guidance[error.code]} Remaining delivery capacity: ${error.remainingImages} images, ${error.remainingBytes} bytes. No visual evidence from this call: no image was delivered. Do not repeat the unchanged failed call or claim to have inspected its pixels.`,
          );
        }
        return result;
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
