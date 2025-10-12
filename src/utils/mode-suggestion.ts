/**
 * Mode suggestion utilities for helping LLMs choose optimal submission modes.
 */

import type { ModeSuggestion } from "../types.js";

/**
 * Analyze candidate and suggest optimal submission mode.
 */
export function suggestOptimalMode(candidate: {
  mode: string;
  changes?: Array<{ path?: string; file?: string; edits?: any[] }>;
  files?: Array<{ path: string; content: string }>;
  patch?: string;
}): ModeSuggestion | undefined {
  // Only provide suggestions for legacy modes or suboptimal patterns
  if (candidate.mode === "diff") {
    const changes = candidate.changes || [];

    // Check if changes are small and targeted
    const hasSmallTargetedChanges = changes.every(c => {
      if (c.edits && Array.isArray(c.edits)) {
        return c.edits.length <= 5; // 5 or fewer edits per file
      }
      return false;
    });

    if (hasSmallTargetedChanges) {
      return {
        recommended: "modify",
        reason: "You're making small targeted changes. 'modify' mode provides better precision and clearer error messages than 'diff' mode.",
        confidence: "high",
        alternatives: {
          diff: "Continue using for changes spanning multiple sections or when you need more flexibility",
          patch: "Use when coordinating changes across multiple files"
        }
      };
    }

    // Multiple files being changed
    if (changes.length > 3) {
      return {
        recommended: "patch",
        reason: `You're modifying ${changes.length} files. 'patch' mode is more efficient for multi-file changes.`,
        confidence: "medium",
        alternatives: {
          modify: "Use for precise, targeted edits with line-by-line control",
          diff: "Continue using if changes are independent per file"
        }
      };
    }
  }

  if (candidate.mode === "files") {
    const files = candidate.files || [];
    const hasExistingFiles = files.some(f => {
      // Heuristic: if content looks like it has existing structure (imports, exports), it's probably modifying
      return f.content.includes("import") || f.content.includes("export");
    });

    if (hasExistingFiles && files.length <= 3) {
      return {
        recommended: "modify",
        reason: "You're providing complete files for what appear to be modifications. 'modify' or 'diff' mode is more efficient and safer for existing files.",
        confidence: "medium",
        alternatives: {
          diff: "Use unified diffs to show only changes",
          files: "Continue using only for completely new files"
        }
      };
    }
  }

  if (candidate.mode === "patch") {
    // Check patch size
    const patchSize = candidate.patch?.length || 0;
    if (patchSize < 500) { // Small patch (< 500 chars)
      return {
        recommended: "modify",
        reason: "Small patch detected. 'modify' mode with edit operations provides better precision and validation.",
        confidence: "low",
        alternatives: {
          patch: "Continue using for multi-file coordinated changes",
          diff: "Use for per-file changes with more flexibility"
        }
      };
    }
  }

  // No suggestion for modify or create modes (already optimal)
  return undefined;
}

/**
 * Generate mode suggestion based on iteration history and patterns.
 */
export function suggestModeFromHistory(
  currentMode: string,
  recentFailures: Array<{ mode: string; error?: string }>
): ModeSuggestion | undefined {
  // If user keeps having patch failures, suggest modify
  const patchFailures = recentFailures.filter(f =>
    f.mode === "patch" && f.error?.includes("Hunk")
  ).length;

  if (patchFailures >= 2 && currentMode === "patch") {
    return {
      recommended: "modify",
      reason: "Multiple patch failures detected. 'modify' mode with semantic edit operations is more reliable for iterative changes.",
      confidence: "high",
      alternatives: {
        patch: "Try regenerating diffs with more context lines",
        diff: "Use per-file diffs for better isolation"
      }
    };
  }

  // If diff mode keeps failing, suggest modify
  const diffFailures = recentFailures.filter(f =>
    f.mode === "diff" && (f.error?.includes("Hunk") || f.error?.includes("line"))
  ).length;

  if (diffFailures >= 2 && currentMode === "diff") {
    return {
      recommended: "modify",
      reason: "Multiple diff failures detected. 'modify' mode provides line-number validation before applying changes.",
      confidence: "high",
      alternatives: {
        diff: "Use getFileContent to get fresh context before generating diffs"
      }
    };
  }

  return undefined;
}
