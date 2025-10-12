/**
 * Baseline state management for resetting to clean state.
 */

import { execa } from "execa";
import pc from "picocolors";
import type { SessionState } from "../types.js";

/**
 * Reset to baseline (clean state)
 */
export async function resetToBaseline(state: SessionState): Promise<void> {
  // If we have a baseline commit, reset to it
  if (state.baselineCommit) {
    try {
      await execa("git", ["reset", "--hard", state.baselineCommit], { cwd: state.cfg.repoPath });
    } catch (err) {
      console.error(pc.yellow(`⚠️  Failed to reset to baseline: ${err}`));
    }
  }

  // Reset state
  state.step = 0;
  state.bestScore = 0;
  state.emaScore = 0;
  state.noImproveStreak = 0;
  state.history = [];
  state.checkpoints.clear();
}
