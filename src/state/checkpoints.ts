/**
 * Checkpoint management for session state restoration.
 */

import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type { SessionState, Checkpoint } from "../types.js";
import { validateSafePath } from "../utils/validation.js";

/**
 * Save current state as a checkpoint
 */
export async function saveCheckpoint(
  state: SessionState,
  description?: string
): Promise<string> {
  const checkpointId = uuidv4();

  // Capture current files in repository (only in snapshot mode)
  const filesSnapshot = new Map<string, string>();
  if (state.mode === "snapshot") {
    try {
      // Read all tracked files that were modified in this session
      for (const filePath of state.modifiedFiles) {
        validateSafePath(state.cfg.repoPath, filePath);
        const absPath = path.resolve(state.cfg.repoPath, filePath);
        if (await fs.pathExists(absPath)) {
          const content = await fs.readFile(absPath, "utf8");
          filesSnapshot.set(filePath, content);
        }
      }
    } catch (err) {
      console.warn(`Warning: Failed to capture file snapshots: ${err}`);
      // Continue anyway - checkpoint without file snapshots
    }
  }
  // For simplicity, we track changes via git or manual snapshot
  // In a production system, you might use git stash or tags

  const checkpoint: Checkpoint = {
    id: checkpointId,
    timestamp: Date.now(),
    step: state.step,
    score: state.bestScore,
    emaScore: state.emaScore,
    filesSnapshot,
    description
  };

  state.checkpoints.set(checkpointId, checkpoint);
  return checkpointId;
}

/**
 * Restore state from a checkpoint
 */
export async function restoreCheckpoint(
  state: SessionState,
  checkpointId: string
): Promise<{ success: boolean; error?: string }> {
  const checkpoint = state.checkpoints.get(checkpointId);
  if (!checkpoint) {
    return { success: false, error: `Checkpoint not found: ${checkpointId}` };
  }

  // Restore state values
  state.step = checkpoint.step;
  state.bestScore = checkpoint.score;
  state.emaScore = checkpoint.emaScore;

  // In snapshot mode, restore files
  if (state.mode === "snapshot" && checkpoint.filesSnapshot.size > 0) {
    try {
      for (const [relPath, content] of checkpoint.filesSnapshot) {
        validateSafePath(state.cfg.repoPath, relPath);
        const absPath = path.resolve(state.cfg.repoPath, relPath);
        await fs.ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, content, "utf8");
      }
    } catch (err) {
      return { 
        success: false, 
        error: `Failed to restore files: ${err instanceof Error ? err.message : String(err)}` 
      };
    }
  }

  return { success: true };
}

/**
 * Create auto-checkpoint after successful iteration
 */
export async function autoCheckpoint(state: SessionState): Promise<void> {
  if (state.history.length > 0) {
    const lastEval = state.history[state.history.length - 1];
    await saveCheckpoint(
      state,
      `Auto-checkpoint at step ${state.step}: score ${lastEval.score.toFixed(3)}`
    );
  }
}
