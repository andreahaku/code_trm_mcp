import type { SaveCheckpointArgs, RestoreCheckpointArgs, ListCheckpointsArgs } from "../../types.js";
import { saveCheckpoint, restoreCheckpoint } from "../../state/checkpoints.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.saveCheckpoint tool.
 * Saves current session state as a checkpoint for later restoration.
 */
export async function handleSaveCheckpoint(args: SaveCheckpointArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const checkpointId = await saveCheckpoint(state, args.description);
  return { content: [{ type: "text", text: JSON.stringify({ checkpointId, message: "Checkpoint saved" }, null, 2) }] };
}

/**
 * Handler for trm.restoreCheckpoint tool.
 * Restores session state from a previously saved checkpoint.
 */
export async function handleRestoreCheckpoint(args: RestoreCheckpointArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const result = await restoreCheckpoint(state, args.checkpointId);
  if (!result.success) {
    return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ message: "Checkpoint restored" }, null, 2) }] };
}

/**
 * Handler for trm.listCheckpoints tool.
 * Lists all saved checkpoints for a session.
 */
export async function handleListCheckpoints(args: ListCheckpointsArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const checkpoints = Array.from(state.checkpoints.values()).map(cp => ({
    id: cp.id,
    timestamp: cp.timestamp,
    step: cp.step,
    score: cp.score,
    emaScore: cp.emaScore,
    description: cp.description
  }));

  return { content: [{ type: "text", text: JSON.stringify({ checkpoints }, null, 2) }] };
}
