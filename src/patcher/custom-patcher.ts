/**
 * Custom patch application with fuzzy matching.
 * Replaces fragile git apply with robust fuzzy-matching patcher.
 */

import fs from "fs-extra";
import path from "path";
import type { EnhancedError, ParsedDiffFile } from "../types.js";
import { validateSafePath } from "../utils/validation.js";
import { parseUnifiedDiff } from "../utils/parser.js";

/**
 * Apply a single hunk to file content with fuzzy matching
 */
export function applyHunk(
  fileLines: string[],
  hunk: any,
  fuzzyThreshold = 2
): { success: boolean; newLines: string[]; error?: EnhancedError } {
  const { oldStart, lines } = hunk;

  // Extract old content from hunk
  const expectedOldLines = lines
    .filter((l: any) => l.type === "context" || l.type === "remove")
    .map((l: any) => l.content);

  // Try exact match first
  let matchIndex = oldStart - 1; // Convert 1-based to 0-based
  let exactMatch = true;

  for (let i = 0; i < expectedOldLines.length; i++) {
    const fileLineIndex = matchIndex + i;
    if (fileLineIndex >= fileLines.length ||
        fileLines[fileLineIndex] !== expectedOldLines[i]) {
      exactMatch = false;
      break;
    }
  }

  // If no exact match, try fuzzy matching
  if (!exactMatch) {
    let bestMatch = -1;
    let bestMatchScore = 0;

    for (let start = Math.max(0, oldStart - 1 - fuzzyThreshold);
         start <= Math.min(fileLines.length - expectedOldLines.length, oldStart - 1 + fuzzyThreshold);
         start++) {
      let matches = 0;
      for (let i = 0; i < expectedOldLines.length; i++) {
        if (fileLines[start + i] === expectedOldLines[i]) {
          matches++;
        }
      }
      if (matches > bestMatchScore) {
        bestMatchScore = matches;
        bestMatch = start;
      }
    }

    if (bestMatchScore / expectedOldLines.length < 0.8) {
      // Failed to find good match
      return {
        success: false,
        newLines: fileLines,
        error: {
          error: "Hunk application failed",
          code: "HUNK_MISMATCH",
          details: {
            failedAt: `line ${oldStart}`,
            reason: "Expected content not found",
            expected: expectedOldLines.slice(0, 3).join("\n"),
            got: fileLines.slice(oldStart - 1, oldStart + 2).join("\n"),
            suggestion: "Content may have been modified. Use trm.getFileContent to get latest content.",
            context: `Best match score: ${(bestMatchScore / expectedOldLines.length * 100).toFixed(1)}%`
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
  fuzzyThreshold = 2
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
