/**
 * Parsing utilities for test output and unified diffs.
 */

import type { ParsedDiffFile, ParsedDiffHunk } from "../types.js";

/**
 * Parse test framework output (Jest, Vitest, Mocha) to extract pass/fail counts.
 * Supports both JSON reporters and text summary formats.
 */
export function parseTestOutput(raw: string): { passed: number; failed: number; total: number } | null {
  // Try to detect jest/mocha minimal info heuristically
  // Accepts either JSON reporters or summary lines.
  try {
    // If JSON array/object with aggregateResults (Jest)
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      if (j.numPassedTests !== undefined && j.numFailedTests !== undefined && j.numTotalTests !== undefined) {
        return { passed: j.numPassedTests, failed: j.numFailedTests, total: j.numTotalTests };
      }
      // Vitest reporter?
      if (j.stats?.passed !== undefined && j.stats?.failed !== undefined && j.stats?.tests !== undefined) {
        return { passed: j.stats.passed, failed: j.stats.failed, total: j.stats.tests };
      }
    }
  } catch {/* not JSON */}
  // Fallback: regex on summary line
  const m = raw.match(/Tests?:\s*(\d+)\s*passed.*?(\d+)\s*total/i) || raw.match(/(\d+)\s*passing.*?(\d+)\s*total/i);
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    return { passed, failed: total - passed, total };
  }
  // Another common: "passed X, failed Y, total Z"
  const m2 = raw.match(/passed\s*:\s*(\d+).*failed\s*:\s*(\d+).*total\s*:\s*(\d+)/i);
  if (m2) {
    const passed = Number(m2[1]), failed = Number(m2[2]), total = Number(m2[3]);
    return { passed, failed, total };
  }
  return null;
}

/**
 * Parse a unified diff into structured changes
 */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const result: ParsedDiffFile[] = [];
  const lines = diff.split(/\r?\n/);

  let currentFile: ParsedDiffFile | null = null;
  let currentHunk: ParsedDiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse file header
    if (line.startsWith("diff --git") || line.startsWith("---")) {
      if (line.startsWith("---")) {
        const nextLine = lines[i + 1];
        if (nextLine?.startsWith("+++")) {
          const filepath = nextLine.slice(4).trim().replace(/^b\//, "");
          currentFile = { file: filepath, hunks: [] };
          result.push(currentFile);
          i++; // Skip +++ line
          continue;
        }
      }
    }

    // Parse hunk header
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match && currentFile) {
        currentHunk = {
          oldStart: parseInt(match[1]),
          oldLines: match[2] ? parseInt(match[2]) : 1,
          newStart: parseInt(match[3]),
          newLines: match[4] ? parseInt(match[4]) : 1,
          lines: []
        };
        currentFile.hunks.push(currentHunk);
      }
      continue;
    }

    // Parse hunk content
    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "context", content: line.slice(1) });
      } else if (line === "") {
        currentHunk.lines.push({ type: "context", content: "" });
      }
    }
  }

  return result;
}
