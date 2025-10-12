/**
 * Custom patch application with fuzzy matching.
 * Replaces fragile git apply with robust fuzzy-matching patcher.
 */

import fs from "fs-extra";
import path from "path";
import type { EnhancedError, ParsedDiffFile, ParsedDiffHunk } from "../types.js";
import { validateSafePath } from "../utils/validation.js";
import { parseUnifiedDiff } from "../utils/parser.js";

/**
 * Patcher constants
 */
const DEFAULT_FUZZY_THRESHOLD = 5; // Search ±5 lines instead of ±2
const MATCH_SCORE_THRESHOLD = 0.7; // Lowered from 0.8 to be more lenient
const ERROR_CONTEXT_LINES = 5; // Show 5 lines of context in errors
const MAX_ERROR_LINE_LENGTH = 100; // Truncate long lines in errors

/**
 * Normalize a line for comparison (removes leading/trailing whitespace, normalizes internal whitespace)
 */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Calculate similarity between two lines (0-1 score)
 */
function lineSimilarity(line1: string, line2: string): number {
  const norm1 = normalizeLine(line1);
  const norm2 = normalizeLine(line2);

  // Exact match after normalization
  if (norm1 === norm2) return 1.0;

  // If one is empty, no similarity
  if (!norm1 || !norm2) return 0;

  // Simple character overlap ratio
  const shorter = norm1.length < norm2.length ? norm1 : norm2;
  const longer = norm1.length >= norm2.length ? norm1 : norm2;

  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }

  return matches / longer.length;
}

/**
 * Apply a single hunk to file content with fuzzy matching
 */
export function applyHunk(
  fileLines: string[],
  hunk: ParsedDiffHunk,
  fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD
): { success: boolean; newLines: string[]; error?: EnhancedError } {
  const { oldStart, lines } = hunk;

  // Extract old content from hunk
  const expectedOldLines = lines
    .filter((l) => l.type === "context" || l.type === "remove")
    .map((l) => l.content);

  // Validate fuzzy threshold parameter
  if (fuzzyThreshold < 0 || fuzzyThreshold > 100) {
    return {
      success: false,
      newLines: fileLines,
      error: {
        error: "Invalid fuzzy threshold",
        code: "INVALID_PARAMETER",
        details: {
          reason: `Fuzzy threshold must be between 0 and 100, got ${fuzzyThreshold}`,
          suggestion: "Use a reasonable threshold value (typically 2-10)"
        }
      }
    };
  }

  // Try exact match first (with normalization)
  let matchIndex = oldStart - 1; // Convert 1-based to 0-based
  let exactMatch = true;

  for (let i = 0; i < expectedOldLines.length; i++) {
    const fileLineIndex = matchIndex + i;
    if (fileLineIndex >= fileLines.length ||
        normalizeLine(fileLines[fileLineIndex]) !== normalizeLine(expectedOldLines[i])) {
      exactMatch = false;
      break;
    }
  }

  // If no exact match, try fuzzy matching with similarity scoring
  if (!exactMatch) {
    let bestMatch = -1;
    let bestMatchScore = 0;

    for (let start = Math.max(0, oldStart - 1 - fuzzyThreshold);
         start <= Math.min(fileLines.length - expectedOldLines.length, oldStart - 1 + fuzzyThreshold);
         start++) {
      let totalSimilarity = 0;
      for (let i = 0; i < expectedOldLines.length; i++) {
        totalSimilarity += lineSimilarity(fileLines[start + i], expectedOldLines[i]);
      }
      const avgSimilarity = totalSimilarity / expectedOldLines.length;
      if (avgSimilarity > bestMatchScore) {
        bestMatchScore = avgSimilarity;
        bestMatch = start;
      }
    }

    if (bestMatchScore < MATCH_SCORE_THRESHOLD) {
      // Failed to find good match - provide detailed error
      const contextStart = Math.max(0, oldStart - 1 - ERROR_CONTEXT_LINES);
      const contextEnd = Math.min(fileLines.length, oldStart - 1 + ERROR_CONTEXT_LINES);
      const actualContext = fileLines.slice(contextStart, contextEnd);

      // Truncate long lines for readability
      const truncateLine = (line: string) =>
        line.length > MAX_ERROR_LINE_LENGTH
          ? line.substring(0, MAX_ERROR_LINE_LENGTH) + "..."
          : line;

      return {
        success: false,
        newLines: fileLines,
        error: {
          error: "Hunk application failed",
          code: "HUNK_MISMATCH",
          details: {
            failedAt: `line ${oldStart}`,
            reason: "Expected content not found with sufficient similarity",
            expected: expectedOldLines.map(truncateLine).join("\n"),
            got: actualContext.map(truncateLine).join("\n"),
            suggestion: "Content may have been modified. Use trm.getFileContent to get latest content, or increase fuzzy threshold.",
            context: `Best match score: ${(bestMatchScore * 100).toFixed(1)}% (threshold: ${(MATCH_SCORE_THRESHOLD * 100).toFixed(0)}%)\nSearched lines ${Math.max(0, oldStart - 1 - fuzzyThreshold)}-${Math.min(fileLines.length, oldStart - 1 + fuzzyThreshold)}`
          }
        }
      };
    }

    matchIndex = bestMatch;
  }

  // Apply the hunk
  const result = [...fileLines];
  let offset = 0;
  let currentLine = matchIndex;

  for (const line of lines) {
    if (line.type === "remove") {
      result.splice(currentLine, 1);
      offset--;
    } else if (line.type === "add") {
      result.splice(currentLine, 0, line.content);
      currentLine++;
      offset++;
    } else {
      // context line
      currentLine++;
    }
  }

  return { success: true, newLines: result };
}

/**
 * Custom patcher with fuzzy matching and detailed error reporting
 */
export async function customPatch(
  repoPath: string,
  diff: string,
  fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD
): Promise<{ success: boolean; errors: EnhancedError[] }> {
  const errors: EnhancedError[] = [];
  const parsedDiff = parseUnifiedDiff(diff);

  for (const fileDiff of parsedDiff) {
    const filePath = path.resolve(repoPath, fileDiff.file);

    try {
      // Validate path
      validateSafePath(repoPath, fileDiff.file);

      // Read current file content
      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, "utf8");
      } catch (err) {
        // File might not exist (new file)
        fileContent = "";
      }

      let fileLines = fileContent.split(/\r?\n/);

      // Apply each hunk
      for (const hunk of fileDiff.hunks) {
        const result = applyHunk(fileLines, hunk, fuzzyThreshold);
        if (!result.success) {
          errors.push(result.error!);
          continue;
        }
        fileLines = result.newLines;
      }

      // Write back if successful
      if (errors.length === 0) {
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, fileLines.join("\n"), "utf8");
      }
    } catch (err: unknown) {
      errors.push({
        error: "File operation failed",
        code: "FILE_ERROR",
        details: {
          failedAt: fileDiff.file,
          reason: err instanceof Error ? err.message : String(err),
          suggestion: "Check file permissions and path"
        }
      });
    }
  }

  return { success: errors.length === 0, errors };
}
