import type { SessionIdArgs } from "../../types.js";
import { resetToBaseline } from "../../state/baseline.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.resetToBaseline tool.
 * Resets session to initial baseline state (using git reset if in a git repository).
 */
export async function handleResetToBaseline(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  await resetToBaseline(state);
  return { content: [{ type: "text", text: JSON.stringify({ message: "Reset to baseline" }, null, 2) }] };
}
