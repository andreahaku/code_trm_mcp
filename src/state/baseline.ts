/**
 * Baseline state management for resetting to clean state.
 */

import { execa } from "execa";
import pc from "picocolors";
import type { SessionState } from "../types.js";

/**
 * Reset to baseline (clean state)
 */
export async function resetToBaseline(
  state: SessionState
): Promise<{ success: boolean; error?: string }> {
  // If we have a baseline commit, reset to it
  if (state.baselineCommit) {
    try {
      // Verify commit exists first
      await execa("git", ["rev-parse", "--verify", state.baselineCommit], { 
        cwd: state.cfg.repoPath 
      });
      
      await execa("git", ["reset", "--hard", state.baselineCommit], { 
        cwd: state.cfg.repoPath 
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(pc.yellow(`⚠️  Failed to reset to baseline: ${errorMsg}`));
      return { success: false, error: `Git reset failed: ${errorMsg}` };
    }
  }

  // Reset state
  state.step = 0;
  state.bestScore = 0;
  state.emaScore = 0;
  state.noImproveStreak = 0;
  state.history = [];
  state.checkpoints.clear();

  return { success: true };
}
