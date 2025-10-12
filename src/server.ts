#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Tool, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import path from "path";
import { execa } from "execa";
import pc from "picocolors";

// Import types
import type {
  SessionId,
  StartSessionArgs,
  SubmitCandidateArgs,
  GetFileContentArgs,
  SessionIdArgs,
  SessionConfig,
  SessionState,
  EvalResult,
  SessionMode,
  Checkpoint,
  CreateSubmission,
  ModifySubmission,
  EditOperation,
  Suggestion,
  CodeIssue,
  EnhancedError,
  ValidationResult,
  ImprovedSubmitCandidateArgs,
  SaveCheckpointArgs,
  RestoreCheckpointArgs,
  ListCheckpointsArgs,
  ImprovedStartSessionArgs,
  CommandResult,
  ParsedDiffFile
} from "./types.js";

// Import constants
import {
  MAX_FILE_SIZE,
  MAX_CANDIDATE_FILES,
  MAX_RATIONALE_LENGTH,
  SCORE_IMPROVEMENT_EPSILON,
  MAX_HINT_LINES,
  MAX_FEEDBACK_ITEMS,
  MAX_FILE_READ_PATHS
} from "./constants.js";

// Import validation utilities
import {
  validateSafePath,
  validateStartSessionArgs,
  isExecaError,
  clamp01
} from "./utils/validation.js";

// Import command utilities
import { parseCommand, runCmd } from "./utils/command.js";

// Import scoring utilities
import { scoreFromSignals, shouldHalt, diffHints } from "./utils/scoring.js";

// Import parser utilities
import { parseTestOutput, parseUnifiedDiff } from "./utils/parser.js";

/**
 * TRM-inspired MCP server for recursive code refinement.
 *
 * Design:
 * - The LLM client (Claude Code / Cursor / Codex CLI) proposes code changes.
 * - This server evaluates candidates (build/test/lint/bench), computes scores,
 *   tracks EMA and improvement deltas, and exposes a halting policy (ACT-like).
 * - State: y=current candidate (implicit in workspace files), z=rationale/notes,
 *   history of evaluations, EMA of score.
 *
 * Tools:
 *  - trm.startSession        : init session on a repo path + commands to run
 *  - trm.submitCandidate     : apply candidate changes (files or unified diff), run eval, return feedback + shouldHalt
 *  - trm.getState            : snapshot of scores/history
 *  - trm.shouldHalt          : return current halting decision
 *  - trm.endSession          : cleanup
 *
 * Scoring:
 *  score in [0..1] from weighted signals:
 *   - tests: passed/total (required if provided)
 *   - build: success/fail
 *   - lint: success/fail (optional)
 *   - perf: normalized vs best-so-far (optional)
 *
 * Halting:
 *  shouldHalt = true if:
 *    - all tests pass AND score >= passThreshold, OR
 *    - no improvement for K consecutive steps, OR
 *    - steps >= maxSteps
 *
 * Safe execution:
 *  - Commands executed in provided repoPath with timeouts.
 *  - No network access, only local cmds.
 */

const sessions = new Map<SessionId, SessionState>();

// ============= CUSTOM PATCHER (replaces git apply) =============

/**
 * Apply a single hunk to file content with fuzzy matching
 */
function applyHunk(
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
async function customPatch(
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

/**
 * Apply semantic edit operations to a file
 */
async function applyEditOperations(
  repoPath: string,
  file: string,
  edits: EditOperation[]
): Promise<{ success: boolean; error?: EnhancedError }> {
  validateSafePath(repoPath, file);
  const filePath = path.resolve(repoPath, file);

  try {
    let content = await fs.readFile(filePath, "utf8");
    let lines = content.split(/\r?\n/);

    // Sort operations by line number (descending) to avoid offset issues
    const sortedEdits = [...edits].sort((a, b) => {
      const aLine = "line" in a ? a.line : "startLine" in a ? a.startLine : 0;
      const bLine = "line" in b ? b.line : "startLine" in b ? b.startLine : 0;
      return bLine - aLine;
    });

    for (const edit of sortedEdits) {
      switch (edit.type) {
        case "replace":
          if (edit.all) {
            content = content.split(edit.oldText).join(edit.newText);
            lines = content.split(/\r?\n/);
          } else {
            const index = content.indexOf(edit.oldText);
            if (index === -1) {
              return {
                success: false,
                error: {
                  error: "Text not found for replacement",
                  code: "REPLACE_NOT_FOUND",
                  details: {
                    reason: "Old text not found in file",
                    expected: edit.oldText.slice(0, 100),
                    suggestion: "Use trm.getFileContent to verify current content"
                  }
                }
              };
            }
            content = content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
            lines = content.split(/\r?\n/);
          }
          break;

        case "insertBefore":
          if (edit.line < 1 || edit.line > lines.length + 1) {
            return {
              success: false,
              error: {
                error: "Invalid line number",
                code: "INVALID_LINE",
                details: {
                  failedAt: `line ${edit.line}`,
                  reason: `Line ${edit.line} out of range (file has ${lines.length} lines)`,
                  suggestion: "Use valid line numbers within file range"
                }
              }
            };
          }
          lines.splice(edit.line - 1, 0, edit.content);
          break;

        case "insertAfter":
          if (edit.line < 1 || edit.line > lines.length) {
            return {
              success: false,
              error: {
                error: "Invalid line number",
                code: "INVALID_LINE",
                details: {
                  failedAt: `line ${edit.line}`,
                  reason: `Line ${edit.line} out of range (file has ${lines.length} lines)`
                }
              }
            };
          }
          lines.splice(edit.line, 0, edit.content);
          break;

        case "replaceLine":
          if (edit.line < 1 || edit.line > lines.length) {
            return {
              success: false,
              error: {
                error: "Invalid line number",
                code: "INVALID_LINE",
                details: {
                  failedAt: `line ${edit.line}`,
                  reason: `Line ${edit.line} out of range`
                }
              }
            };
          }
          lines[edit.line - 1] = edit.content;
          break;

        case "replaceRange":
          if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
            return {
              success: false,
              error: {
                error: "Invalid line range",
                code: "INVALID_RANGE",
                details: {
                  failedAt: `lines ${edit.startLine}-${edit.endLine}`,
                  reason: "Invalid range specified"
                }
              }
            };
          }
          lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, edit.content);
          break;

        case "deleteLine":
          if (edit.line < 1 || edit.line > lines.length) {
            return {
              success: false,
              error: {
                error: "Invalid line number",
                code: "INVALID_LINE",
                details: {
                  failedAt: `line ${edit.line}`,
                  reason: `Line ${edit.line} out of range`
                }
              }
            };
          }
          lines.splice(edit.line - 1, 1);
          break;

        case "deleteRange":
          if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
            return {
              success: false,
              error: {
                error: "Invalid line range",
                code: "INVALID_RANGE",
                details: {
                  failedAt: `lines ${edit.startLine}-${edit.endLine}`,
                  reason: "Invalid range specified"
                }
              }
            };
          }
          lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1);
          break;
      }
    }

    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    return { success: true };
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        error: "Edit operation failed",
        code: "EDIT_ERROR",
        details: {
          reason: err instanceof Error ? err.message : String(err),
          suggestion: "Check file exists and is accessible"
        }
      }
    };
  }
}

/**
 * Apply candidate changes to the repository using git apply (for diffs) or direct writes (for files).
 * Validates file sizes and paths to prevent abuse.
 */
async function applyCandidate(
  repoPath: string,
  candidate: { mode: "diff"; changes: { path: string; diff: string }[] } |
             { mode: "patch"; patch: string } |
             { mode: "files"; files: { path: string; content: string }[] }
) {
  if (candidate.mode === "diff") {
    // Apply multiple file diffs using custom patcher
    if (candidate.changes.length > MAX_CANDIDATE_FILES) {
      throw new Error(`Too many files in candidate: ${candidate.changes.length} (max ${MAX_CANDIDATE_FILES})`);
    }

    for (const change of candidate.changes) {
      validateSafePath(repoPath, change.path);

      // Validate diff size
      const sizeBytes = Buffer.byteLength(change.diff, 'utf8');
      if (sizeBytes > MAX_FILE_SIZE) {
        throw new Error(`Diff too large for ${change.path}: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
      }

      // Use custom patcher with fuzzy matching
      const result = await customPatch(repoPath, change.diff);
      if (!result.success) {
        throw new Error(`Patch application failed:\n${JSON.stringify(result.errors[0], null, 2)}`);
      }
    }
    return;
  } else if (candidate.mode === "patch") {
    // Validate patch size
    const sizeBytes = Buffer.byteLength(candidate.patch, 'utf8');
    if (sizeBytes > MAX_FILE_SIZE) {
      throw new Error(`Patch too large: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    }

    // Use custom patcher instead of git apply
    const result = await customPatch(repoPath, candidate.patch);
    if (!result.success) {
      throw new Error(`Patch application failed:\n${JSON.stringify(result.errors[0], null, 2)}`);
    }
  } else {
    // files mode
    // Validate limits
    if (candidate.files.length > MAX_CANDIDATE_FILES) {
      throw new Error(`Too many files in candidate: ${candidate.files.length} (max ${MAX_CANDIDATE_FILES})`);
    }

    // Warn about large submissions
    const totalSize = candidate.files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
    if (totalSize > 100_000) { // 100KB
      console.error(pc.yellow(`⚠️  Large submission (${(totalSize/1024).toFixed(1)}KB) - consider using 'diff' or 'patch' mode for efficiency`));
    }

    for (const f of candidate.files) {
      // Validate path to prevent traversal
      validateSafePath(repoPath, f.path);

      // Validate file size
      const sizeBytes = Buffer.byteLength(f.content, 'utf8');
      if (sizeBytes > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${f.path} is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
      }

      const abs = path.resolve(repoPath, f.path);
      await fs.ensureDir(path.dirname(abs));
      await fs.writeFile(abs, f.content, "utf8");
    }
  }
}

// ============= CODE ANALYZER FOR SMART SUGGESTIONS =============

/**
 * Analyze code file for quality issues
 */
async function analyzeCodeFile(filePath: string): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    // Detect 'any' types
    lines.forEach((line, idx) => {
      if (line.match(/:\s*any\b/) && !line.trim().startsWith("//")) {
        issues.push({
          type: "any-type",
          severity: "warning",
          file: filePath,
          line: idx + 1,
          message: "Use of 'any' type reduces type safety",
          context: line.trim()
        });
      }
    });

    // Detect magic numbers
    lines.forEach((line, idx) => {
      const matches = line.match(/(?<![a-zA-Z0-9_])(\d+)(?![a-zA-Z0-9_])/g);
      if (matches) {
        // Filter out common non-magic numbers (0, 1, -1, 2, 100)
        const magicNumbers = matches.filter(n =>
          !["0", "1", "-1", "2", "100", "10", "1000"].includes(n)
        );
        if (magicNumbers.length > 0 && !line.trim().startsWith("//")) {
          issues.push({
            type: "magic-number",
            severity: "info",
            file: filePath,
            line: idx + 1,
            message: `Magic numbers found: ${magicNumbers.join(", ")}. Consider using named constants.`,
            context: line.trim()
          });
        }
      }
    });

    // Detect missing JSDoc on functions
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);
      if (match) {
        // Check if previous line has JSDoc comment
        const prevLine = i > 0 ? lines[i - 1].trim() : "";
        const hasDocs = prevLine.endsWith("*/") || prevLine.startsWith("/**");
        if (!hasDocs) {
          issues.push({
            type: "missing-jsdoc",
            severity: "info",
            file: filePath,
            line: i + 1,
            message: `Function '${match[1]}' lacks JSDoc documentation`
          });
        }
      }
    }

    // Detect long functions (> 100 lines)
    let functionStart = -1;
    let braceCount = 0;
    let functionName = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);
      if (match && functionStart === -1) {
        functionStart = i;
        functionName = match[1];
        braceCount = 0;
      }

      if (functionStart !== -1) {
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        if (braceCount === 0 && line.includes("}")) {
          const length = i - functionStart + 1;
          if (length > 100) {
            issues.push({
              type: "long-function",
              severity: "warning",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' is ${length} lines long. Consider breaking it down.`
            });
          }
          functionStart = -1;
        }
      }
    }

    // Detect missing error handling in async functions
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/async\s+function/) || lines[i].match(/async\s*\(/)) {
        let hasTryCatch = false;
        // Look ahead 20 lines for try/catch
        for (let j = i; j < Math.min(i + 20, lines.length); j++) {
          if (lines[j].includes("try {") || lines[j].includes("catch")) {
            hasTryCatch = true;
            break;
          }
        }
        if (!hasTryCatch && lines[i].includes("function")) {
          issues.push({
            type: "no-error-handling",
            severity: "warning",
            file: filePath,
            line: i + 1,
            message: "Async function may lack error handling (no try/catch found)"
          });
        }
      }
    }

  } catch (err) {
    // Ignore errors in analysis (file might not exist, etc.)
  }

  return issues;
}

/**
 * Calculate cyclomatic complexity for a function
 */
function calculateCyclomaticComplexity(functionLines: string[]): number {
  const code = functionLines.join('\n');
  // Count decision points: if, for, while, case, &&, ||, ?, catch, ??, ?.
  const decisionPoints = (code.match(/\b(if|for|while|case|catch)\b|\&\&|\|\||\?(?!\?|\.)|\?\?|\?\./g) || []).length;
  return decisionPoints + 1; // Base complexity is 1
}

/**
 * Detect maximum nesting depth in a function
 */
function detectMaxNesting(functionLines: string[]): number {
  let maxNesting = 0;
  let currentNesting = 0;

  for (const line of functionLines) {
    // Count opening braces
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    currentNesting += opens;
    if (currentNesting > maxNesting) {
      maxNesting = currentNesting;
    }
    currentNesting -= closes;
  }

  return maxNesting;
}

/**
 * Enhanced code analysis with maintainability and testability checks
 */
async function analyzeCodeFileEnhanced(filePath: string): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    // 1. Check module size (file length)
    if (lines.length > 500) {
      issues.push({
        type: "large-module",
        severity: "warning",
        file: filePath,
        line: 1,
        message: `File is ${lines.length} lines long. Consider splitting into focused modules for better maintainability and testability.`,
        context: "Large files are harder to test, understand, and maintain"
      });
    }

    // Run existing checks
    const basicIssues = await analyzeCodeFile(filePath);
    issues.push(...basicIssues);

    // 2. Enhanced function analysis with complexity and nesting
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
    let functionStart = -1;
    let functionName = "";
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);

      if (match && functionStart === -1) {
        functionStart = i;
        functionName = match[1];
        braceCount = 0;
      }

      if (functionStart !== -1) {
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        if (braceCount === 0 && line.includes("}")) {
          const functionLines = lines.slice(functionStart, i + 1);

          // Check cyclomatic complexity
          const complexity = calculateCyclomaticComplexity(functionLines);
          if (complexity > 10) {
            issues.push({
              type: "high-complexity",
              severity: complexity > 15 ? "warning" : "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has cyclomatic complexity of ${complexity} (threshold: 10). High complexity makes code harder to test and maintain.`,
              context: `Consider splitting into smaller functions with single responsibilities`
            });
          }

          // Check nesting depth
          const maxNesting = detectMaxNesting(functionLines);
          if (maxNesting > 4) {
            issues.push({
              type: "deep-nesting",
              severity: "warning",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has nesting depth of ${maxNesting} (threshold: 4). Deep nesting reduces testability.`,
              context: "Consider extracting nested logic into separate functions"
            });
          }

          // Check for side effects (impure functions)
          const hasSideEffects = functionLines.some(l =>
            l.match(/\b(fs\.|console\.|process\.|global\.|localStorage\.|sessionStorage\.|document\.|window\.)/i)
          );
          if (hasSideEffects && !functionName.match(/^(log|write|save|update|delete|execute|run|apply|init)/i)) {
            issues.push({
              type: "impure-function",
              severity: "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has side effects but name doesn't indicate it. Impure functions are harder to test.`,
              context: "Consider separating pure logic from side effects, or use naming that indicates side effects"
            });
          }

          // Check for hard-to-mock patterns (direct instantiation)
          const hasDirectInstantiation = functionLines.some(l =>
            l.match(/new\s+[A-Z][a-zA-Z0-9_]*\(/) && !l.match(/new\s+(Map|Set|Array|Date|Error|Promise)\(/)
          );
          if (hasDirectInstantiation && functionLines.length > 10) {
            issues.push({
              type: "hard-to-mock",
              severity: "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' creates its own dependencies. Consider dependency injection for easier testing.`,
              context: "Pass dependencies as parameters instead of creating them internally"
            });
          }

          functionStart = -1;
        }
      }
    }

  } catch (err) {
    // Ignore errors in analysis
  }

  return issues;
}

/**
 * Generate smart suggestions based on evaluation results and code analysis
 */
async function generateSuggestions(
  state: SessionState,
  lastEval: EvalResult
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  // Analyze build/test/lint failures
  if (!lastEval.okBuild) {
    suggestions.push({
      priority: "critical",
      category: "code-quality",
      issue: "Build is failing",
      suggestedFix: "Fix compilation/type errors reported in feedback",
      autoFixable: false
    });
  }

  if (lastEval.tests && lastEval.tests.failed > 0) {
    suggestions.push({
      priority: "critical",
      category: "test-coverage",
      issue: `${lastEval.tests.failed} tests are failing`,
      suggestedFix: "Fix failing tests or update assertions",
      autoFixable: false
    });
  }

  if (!lastEval.okLint) {
    suggestions.push({
      priority: "high",
      category: "code-quality",
      issue: "Lint check is failing",
      suggestedFix: "Fix linting errors reported in feedback",
      autoFixable: true
    });
  }

  // Analyze source files for issues (sample a few key files)
  const repoPath = state.cfg.repoPath;
  const typescriptFiles = await fs.readdir(path.join(repoPath, "src")).catch(() => []);

  const filesToAnalyze = typescriptFiles
    .filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
    .slice(0, 5); // Analyze up to 5 files

  for (const file of filesToAnalyze) {
    const filePath = path.join(repoPath, "src", file);
    const issues = await analyzeCodeFileEnhanced(filePath);

    // Group by type
    const anyTypes = issues.filter(i => i.type === "any-type");
    const missingDocs = issues.filter(i => i.type === "missing-jsdoc");
    const magicNumbers = issues.filter(i => i.type === "magic-number");
    const largeModules = issues.filter(i => i.type === "large-module");
    const highComplexity = issues.filter(i => i.type === "high-complexity");
    const deepNesting = issues.filter(i => i.type === "deep-nesting");
    const impureFunctions = issues.filter(i => i.type === "impure-function");
    const hardToMock = issues.filter(i => i.type === "hard-to-mock");

    if (anyTypes.length > 0) {
      suggestions.push({
        priority: "high",
        category: "type-safety",
        issue: `${anyTypes.length} usage(s) of 'any' type detected`,
        locations: anyTypes.slice(0, 3).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.context
        })),
        suggestedFix: "Replace 'any' with specific types or 'unknown' with type guards",
        autoFixable: true
      });
    }

    if (missingDocs.length > 3) {
      suggestions.push({
        priority: "medium",
        category: "documentation",
        issue: `${missingDocs.length} functions in ${file} lack JSDoc`,
        suggestedFix: "Add JSDoc comments to exported functions",
        autoFixable: false
      });
    }

    if (magicNumbers.length > 5) {
      suggestions.push({
        priority: "low",
        category: "code-quality",
        issue: `${magicNumbers.length} magic numbers detected in ${file}`,
        suggestedFix: "Extract magic numbers to named constants",
        autoFixable: false
      });
    }

    // Maintainability: large modules
    if (largeModules.length > 0) {
      const moduleIssue = largeModules[0];
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: moduleIssue.message,
        locations: [{ file: `src/${file}`, line: moduleIssue.line }],
        suggestedFix: "Split into focused modules by grouping related functions. Consider domain-driven organization or separation by responsibility (e.g., utils, validation, processing).",
        autoFixable: false
      });
    }

    // Testability: high complexity
    if (highComplexity.length > 0) {
      suggestions.push({
        priority: "high",
        category: "code-quality",
        issue: `${highComplexity.length} function(s) in ${file} have high cyclomatic complexity`,
        locations: highComplexity.slice(0, 3).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Reduce complexity by extracting conditional logic into separate functions with clear names. Use early returns, guard clauses, and strategy patterns.",
        autoFixable: false
      });
    }

    // Testability: deep nesting
    if (deepNesting.length > 0) {
      suggestions.push({
        priority: "high",
        category: "code-quality",
        issue: `${deepNesting.length} function(s) in ${file} have deep nesting (reduces testability)`,
        locations: deepNesting.slice(0, 3).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Reduce nesting by extracting nested blocks into helper functions. Use early returns and guard clauses to flatten control flow.",
        autoFixable: false
      });
    }

    // Testability: impure functions
    if (impureFunctions.length > 2) {
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: `${impureFunctions.length} function(s) in ${file} have side effects but unclear naming`,
        locations: impureFunctions.slice(0, 3).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Separate pure logic from side effects. Use command-query separation: pure functions for calculations, clearly named functions for side effects (e.g., executeX, saveX, logX).",
        autoFixable: false
      });
    }

    // Testability: hard to mock
    if (hardToMock.length > 0) {
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: `${hardToMock.length} function(s) in ${file} create dependencies internally (hard to test)`,
        locations: hardToMock.slice(0, 3).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Use dependency injection: pass dependencies as function parameters or constructor arguments instead of instantiating them internally. This enables mocking in tests.",
        autoFixable: false
      });
    }
  }

  // Performance suggestions
  if (lastEval.perf && state.bestPerf && lastEval.perf.value > state.bestPerf * 1.1) {
    suggestions.push({
      priority: "medium",
      category: "performance",
      issue: "Performance has regressed by >10%",
      suggestedFix: "Profile and optimize critical paths, or revert recent changes",
      autoFixable: false
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions.slice(0, 5); // Return top 5 suggestions
}

/**
 * Apply improved candidate format (create/modify modes)
 */
async function applyImprovedCandidate(
  repoPath: string,
  candidate: CreateSubmission | ModifySubmission
): Promise<{ success: boolean; errors: EnhancedError[] }> {
  const errors: EnhancedError[] = [];

  if (candidate.mode === "create") {
    // Create new files
    for (const file of candidate.files) {
      try {
        validateSafePath(repoPath, file.path);

        const sizeBytes = Buffer.byteLength(file.content, 'utf8');
        if (sizeBytes > MAX_FILE_SIZE) {
          errors.push({
            error: "File too large",
            code: "FILE_TOO_LARGE",
            details: {
              failedAt: file.path,
              reason: `File is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
              suggestion: "Split into smaller files or reduce content size"
            }
          });
          continue;
        }

        const absPath = path.resolve(repoPath, file.path);

        // Check if file already exists
        if (await fs.pathExists(absPath)) {
          errors.push({
            error: "File already exists",
            code: "FILE_EXISTS",
            details: {
              failedAt: file.path,
              reason: "Cannot create file that already exists",
              suggestion: "Use 'modify' mode to update existing files or choose a different path"
            }
          });
          continue;
        }

        await fs.ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, file.content, "utf8");
      } catch (err: unknown) {
        errors.push({
          error: "File creation failed",
          code: "CREATE_ERROR",
          details: {
            failedAt: file.path,
            reason: err instanceof Error ? err.message : String(err),
            suggestion: "Check file path and permissions"
          }
        });
      }
    }
  } else {
    // Modify existing files using edit operations
    for (const change of candidate.changes) {
      const result = await applyEditOperations(repoPath, change.file, change.edits);
      if (!result.success && result.error) {
        errors.push(result.error);
      }
    }
  }

  return { success: errors.length === 0, errors };
}

/**
 * Validate candidate changes without applying (dry-run)
 */
async function validateCandidate(
  repoPath: string,
  candidate: CreateSubmission | ModifySubmission |
            { mode: "diff"; changes: { path: string; diff: string }[] } |
            { mode: "patch"; patch: string } |
            { mode: "files"; files: { path: string; content: string }[] }
): Promise<ValidationResult> {
  const errors: EnhancedError[] = [];
  const warnings: string[] = [];
  let filesAffected: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesModified = 0;

  try {
    if (candidate.mode === "create") {
      // Validate create mode
      for (const file of candidate.files) {
        // Check if file already exists
        const absPath = path.resolve(repoPath, file.path);
        if (await fs.pathExists(absPath)) {
          errors.push({
            error: "File already exists",
            code: "FILE_EXISTS",
            details: {
              failedAt: file.path,
              reason: "Cannot create file that already exists",
              suggestion: "Use 'modify' mode instead"
            }
          });
        }

        // Validate path safety
        try {
          validateSafePath(repoPath, file.path);
        } catch (err) {
          errors.push({
            error: "Invalid path",
            code: "INVALID_PATH",
            details: {
              failedAt: file.path,
              reason: err instanceof Error ? err.message : String(err),
              suggestion: "Use relative paths within repository"
            }
          });
        }

        // Check file size
        const sizeBytes = Buffer.byteLength(file.content, 'utf8');
        if (sizeBytes > MAX_FILE_SIZE) {
          errors.push({
            error: "File too large",
            code: "FILE_TOO_LARGE",
            details: {
              failedAt: file.path,
              reason: `File is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
              suggestion: "Split into smaller files"
            }
          });
        }

        filesAffected.push(file.path);
        linesAdded += file.content.split('\n').length;
      }
    } else if (candidate.mode === "modify") {
      // Validate modify mode
      for (const change of candidate.changes) {
        const absPath = path.resolve(repoPath, change.file);

        // Check if file exists
        if (!(await fs.pathExists(absPath))) {
          errors.push({
            error: "File not found",
            code: "FILE_NOT_FOUND",
            details: {
              failedAt: change.file,
              reason: "File does not exist",
              suggestion: "Use 'create' mode for new files"
            }
          });
          continue;
        }

        // Validate edits
        const content = await fs.readFile(absPath, "utf8");
        const lines = content.split(/\r?\n/);

        for (const edit of change.edits) {
          switch (edit.type) {
            case "replace":
              if (!edit.all && !content.includes(edit.oldText)) {
                warnings.push(`Text not found in ${change.file}: "${edit.oldText.slice(0, 50)}..."`);
              }
              break;
            case "insertBefore":
            case "insertAfter":
            case "replaceLine":
            case "deleteLine":
              if ('line' in edit && (edit.line < 1 || edit.line > lines.length)) {
                errors.push({
                  error: "Invalid line number",
                  code: "INVALID_LINE",
                  details: {
                    failedAt: `${change.file}:${edit.line}`,
                    reason: `Line ${edit.line} out of range (file has ${lines.length} lines)`,
                    suggestion: "Use valid line numbers"
                  }
                });
              }
              break;
            case "replaceRange":
            case "deleteRange":
              if (edit.startLine < 1 || edit.endLine > lines.length || edit.startLine > edit.endLine) {
                errors.push({
                  error: "Invalid line range",
                  code: "INVALID_RANGE",
                  details: {
                    failedAt: `${change.file}:${edit.startLine}-${edit.endLine}`,
                    reason: "Invalid range specified",
                    suggestion: "Check line numbers"
                  }
                });
              }
              break;
          }
        }

        filesAffected.push(change.file);
        linesModified += change.edits.length;
      }
    } else if (candidate.mode === "diff" || candidate.mode === "patch") {
      // Validate diff/patch mode
      const diffText = candidate.mode === "patch" ? candidate.patch : candidate.changes[0]?.diff || "";

      // Basic diff validation
      if (!diffText.includes("@@")) {
        errors.push({
          error: "Invalid diff format",
          code: "INVALID_DIFF",
          details: {
            reason: "No hunk headers found",
            suggestion: "Use unified diff format (git diff style)"
          }
        });
      }

      // Parse and validate
      const parsedDiff = parseUnifiedDiff(diffText);
      filesAffected = parsedDiff.map(d => d.file);

      for (const fileDiff of parsedDiff) {
        for (const hunk of fileDiff.hunks) {
          linesAdded += hunk.lines.filter(l => l.type === "add").length;
          linesRemoved += hunk.lines.filter(l => l.type === "remove").length;
        }
      }
    } else if (candidate.mode === "files") {
      // Validate files mode
      const totalSize = candidate.files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
      if (totalSize > 100_000) {
        warnings.push(`Large submission (${(totalSize / 1024).toFixed(1)}KB) - consider using 'diff' or 'modify' mode`);
      }

      filesAffected = candidate.files.map(f => f.path);
      linesAdded = candidate.files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    }

  } catch (err: unknown) {
    errors.push({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: {
        reason: err instanceof Error ? err.message : String(err),
        suggestion: "Check candidate format"
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    preview: {
      filesAffected: [...new Set(filesAffected)],
      linesAdded,
      linesRemoved,
      linesModified
    }
  };
}

// ============= STATE MANAGEMENT =============

/**
 * Save current state as a checkpoint
 */
async function saveCheckpoint(
  state: SessionState,
  description?: string
): Promise<string> {
  const checkpointId = uuidv4();

  // Capture current files in repository
  const filesSnapshot = new Map<string, string>();
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
async function restoreCheckpoint(
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
    for (const [relPath, content] of checkpoint.filesSnapshot) {
      const absPath = path.resolve(state.cfg.repoPath, relPath);
      await fs.ensureDir(path.dirname(absPath));
      await fs.writeFile(absPath, content, "utf8");
    }
  }

  return { success: true };
}

/**
 * Reset to baseline (clean state)
 */
async function resetToBaseline(state: SessionState): Promise<void> {
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

/**
 * Create auto-checkpoint after successful iteration
 */
async function autoCheckpoint(state: SessionState): Promise<void> {
  if (state.history.length > 0) {
    const lastEval = state.history[state.history.length - 1];
    await saveCheckpoint(
      state,
      `Auto-checkpoint at step ${state.step}: score ${lastEval.score.toFixed(3)}`
    );
  }
}

// ------------- MCP server ----------------

const transport = new StdioServerTransport();
const server = new Server(
  {
    name: "mcp-trm-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
      resources: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "trm.startSession",
    description: "Initialize a TRM session on a local repository with evaluation commands and halting policy.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Absolute path to the project repository" },
        buildCmd: { type: "string" },
        testCmd: { type: "string" },
        lintCmd: { type: "string" },
        benchCmd: { type: "string" },
        timeoutSec: { type: "number", default: 120 },
        weights: {
          type: "object",
          properties: {
            build: { type: "number", default: 0.3 },
            test: { type: "number", default: 0.5 },
            lint: { type: "number", default: 0.1 },
            perf: { type: "number", default: 0.1 }
          },
          required: []
        },
        halt: {
          type: "object",
          properties: {
            maxSteps: { type: "number", default: 12 },
            passThreshold: { type: "number", default: 0.95 },
            patienceNoImprove: { type: "number", default: 3 },
            minSteps: { type: "number", default: 1 }
          },
          required: ["maxSteps", "passThreshold", "patienceNoImprove"]
        },
        emaAlpha: { type: "number", default: 0.9 },
        zNotes: { type: "string", description: "Optional initial reasoning notes/hints" }
      },
      required: ["repoPath", "halt"]
    }
  },
  {
    name: "trm.submitCandidate",
    description: "Apply candidate changes and run evaluation. **STRONGLY PREFERRED: Use 'diff' mode (per-file diffs) or 'patch' mode (unified diff) for efficiency.** Use trm.getFileContent first to read current file state, then generate diffs. Only use 'files' mode for new files or complete rewrites (discouraged for large files).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidate: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "diff" },
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Relative path to file" },
                      diff: { type: "string", description: "Unified diff format (git diff style)" }
                    },
                    required: ["path", "diff"]
                  },
                  description: "Array of per-file diffs in unified format"
                }
              },
              required: ["mode", "changes"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "patch" },
                patch: { type: "string", description: "Complete unified diff (git diff output)" }
              },
              required: ["mode", "patch"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "files" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  },
                  description: "Complete file contents (use only for new files)"
                }
              },
              required: ["mode", "files"]
            }
          ]
        },
        rationale: { type: "string", description: "LLM notes: why these changes, expected effects, hypotheses" }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getFileContent",
    description: "Read current content of files from the repository. Use this before generating diffs to ensure accurate changes. Returns file contents indexed by path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Relative paths to read from repository (e.g., ['src/server.ts', 'package.json'])"
        }
      },
      required: ["sessionId", "paths"]
    }
  },
  {
    name: "trm.getState",
    description: "Return current TRM state (scores, EMA, history summary).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.shouldHalt",
    description: "Return halting decision based on latest evaluation.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.endSession",
    description: "End and remove a TRM session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.validateCandidate",
    description: "Validate candidate changes without applying them (dry-run). Returns validation results with errors, warnings, and preview of changes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidate: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "create" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              required: ["mode", "files"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "modify" },
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      file: { type: "string" },
                      edits: { type: "array" }
                    },
                    required: ["file", "edits"]
                  }
                }
              },
              required: ["mode", "changes"]
            }
          ]
        }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getSuggestions",
    description: "Get AI-powered suggestions for code improvements based on evaluation results and code analysis. Returns top suggestions prioritized by criticality.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.saveCheckpoint",
    description: "Save current session state as a checkpoint for later restoration.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        description: { type: "string", description: "Optional description for the checkpoint" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.restoreCheckpoint",
    description: "Restore session state from a previously saved checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        checkpointId: { type: "string" }
      },
      required: ["sessionId", "checkpointId"]
    }
  },
  {
    name: "trm.listCheckpoints",
    description: "List all saved checkpoints for a session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.resetToBaseline",
    description: "Reset session to initial baseline state (using git reset if in a git repository).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  }
];

// Register tools list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find(t => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }

  try {
    switch (req.params.name) {
      case "trm.startSession": {
        const p = req.params.arguments as StartSessionArgs;

        // Validate input arguments
        await validateStartSessionArgs(p);

        const id: SessionId = uuidv4();
        const cfg: SessionConfig = {
          repoPath: path.resolve(p.repoPath),
          buildCmd: p.buildCmd,
          testCmd: p.testCmd,
          lintCmd: p.lintCmd,
          benchCmd: p.benchCmd,
          timeoutSec: p.timeoutSec ?? 120,
          weights: {
            build: p.weights?.build ?? 0.3,
            test: p.weights?.test ?? 0.5,
            lint: p.weights?.lint ?? 0.1,
            perf: p.weights?.perf ?? 0.1
          },
          halt: {
            maxSteps: p.halt.maxSteps,
            passThreshold: p.halt.passThreshold,
            patienceNoImprove: p.halt.patienceNoImprove,
            minSteps: p.halt.minSteps ?? 1
          }
        };
        // Get current git commit as baseline (if in git repo)
        let baselineCommit: string | undefined;
        try {
          const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: cfg.repoPath });
          baselineCommit = stdout.trim();
        } catch {
          // Not in git repo or git not available
        }

        const state: SessionState = {
          id,
          cfg,
          createdAt: Date.now(),
          step: 0,
          bestScore: 0,
          emaScore: 0,
          emaAlpha: p.emaAlpha ?? 0.9,
          noImproveStreak: 0,
          history: [],
          zNotes: p.zNotes || undefined,
          mode: (p as ImprovedStartSessionArgs).mode ?? "cumulative",
          checkpoints: new Map(),
          baselineCommit
        };
        sessions.set(id, state);
        return {
          content: [{ type: "text", text: JSON.stringify({ sessionId: id, message: "TRM session started" }, null, 2) }]
        };
      }

      case "trm.submitCandidate": {
        const p = req.params.arguments as SubmitCandidateArgs;
        const state = sessions.get(p.sessionId);
        if (!state) {
          return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };
        }

        // Apply candidate
        await applyCandidate(state.cfg.repoPath, p.candidate);
        if (typeof p.rationale === "string" && p.rationale.trim().length) {
          // Keep only the latest rationale (TRM z feature)
          state.zNotes = p.rationale.slice(0, MAX_RATIONALE_LENGTH);
        }

        // Evaluate
        state.step += 1;
        const tSec = state.cfg.timeoutSec ?? 120;

        const build = await runCmd(state.cfg.buildCmd, state.cfg.repoPath, tSec);
        const lint = await runCmd(state.cfg.lintCmd, state.cfg.repoPath, Math.max(30, tSec / 2));
        const test = await runCmd(state.cfg.testCmd, state.cfg.repoPath, tSec);
        const bench = await runCmd(state.cfg.benchCmd, state.cfg.repoPath, tSec);

        const testParsed = state.cfg.testCmd ? parseTestOutput(test.stdout || test.stderr || "") : null;

        const score = scoreFromSignals(state, {
          buildOk: build.ok,
          lintOk: lint.ok,
          tests: testParsed ? { passed: testParsed.passed, total: testParsed.total } : undefined,
          perf: state.cfg.benchCmd ? { value: parseFloat((bench.stdout || bench.stderr).match(/([\d.]+)$/)?.[1] || "NaN") } : undefined
        });

        // EMA
        state.emaScore = state.step === 1 ? score : (state.emaAlpha * state.emaScore + (1 - state.emaAlpha) * score);

        // Improvement tracking
        if (score > state.bestScore + SCORE_IMPROVEMENT_EPSILON) {
          state.bestScore = score;
          state.noImproveStreak = 0;
        } else {
          state.noImproveStreak += 1;
        }

        const feedback: string[] = [];
        if (!build.ok) feedback.push("Build failed – fix compilation/type errors.");
        if (state.cfg.testCmd) {
          if (!testParsed) {
            feedback.push("Tests output not parsed – prefer JSON reporter or include summary lines.");
          } else {
            feedback.push(`Tests: ${testParsed.passed}/${testParsed.total} passed.`);
            if (testParsed.failed > 0) feedback.push(`There are ${testParsed.failed} failing tests.`);
          }
        }
        if (state.cfg.lintCmd && !lint.ok) {
          feedback.push("Lint failed – fix style/static-analysis issues.");
        }
        if (state.cfg.benchCmd && bench.ok) {
          feedback.push("Benchmark executed – try improving critical hot paths while keeping correctness.");
        }

        const hintLines = [
          ...diffHints(build.stderr, build.stdout),
          ...diffHints(test.stderr, test.stdout),
          ...diffHints(lint.stderr, lint.stdout)
        ].slice(0, MAX_HINT_LINES);

        const evalResult: EvalResult = {
          okBuild: build.ok,
          okLint: lint.ok,
          tests: testParsed ? { ...testParsed, raw: "" } : undefined,
          perf: state.cfg.benchCmd && isFinite(Number(bench.stdout)) ? { value: Number(bench.stdout) } : undefined,
          score,
          emaScore: state.emaScore,
          step: state.step,
          feedback: [...new Set([...feedback, ...hintLines])].slice(0, MAX_FEEDBACK_ITEMS),
          shouldHalt: false,
          reasons: []
        };

        const haltDecision = shouldHalt(state, evalResult);
        evalResult.shouldHalt = haltDecision.halt;
        evalResult.reasons = haltDecision.reasons;

        state.history.push(evalResult);

        const compact = {
          step: evalResult.step,
          score: evalResult.score,
          emaScore: evalResult.emaScore,
          bestScore: state.bestScore,
          noImproveStreak: state.noImproveStreak,
          tests: evalResult.tests,
          okBuild: evalResult.okBuild,
          okLint: evalResult.okLint,
          shouldHalt: evalResult.shouldHalt,
          reasons: evalResult.reasons,
          feedback: evalResult.feedback
        };

        return { content: [{ type: "text", text: JSON.stringify(compact, null, 2) }] };
      }

      case "trm.getState": {
        const p = req.params.arguments as SessionIdArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const last = state.history[state.history.length - 1];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sessionId: state.id,
              step: state.step,
              emaScore: state.emaScore,
              bestScore: state.bestScore,
              noImproveStreak: state.noImproveStreak,
              last,
              zNotes: state.zNotes
            }, null, 2)
          }]
        };
      }

      case "trm.shouldHalt": {
        const p = req.params.arguments as SessionIdArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };
        const last = state.history[state.history.length - 1];
        if (!last) return { content: [{ type: "text", text: JSON.stringify({ shouldHalt: false, reasons: ["no evaluations yet"] }, null, 2) }] };
        const d = shouldHalt(state, last);
        return { content: [{ type: "text", text: JSON.stringify({ shouldHalt: d.halt, reasons: d.reasons }, null, 2) }] };
      }

      case "trm.getFileContent": {
        const p = req.params.arguments as GetFileContentArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        if (p.paths.length > MAX_FILE_READ_PATHS) {
          throw new Error(`Too many paths requested: ${p.paths.length} (max ${MAX_FILE_READ_PATHS})`);
        }

        const files: Record<string, string> = {};
        for (const relPath of p.paths) {
          validateSafePath(state.cfg.repoPath, relPath);
          const absPath = path.resolve(state.cfg.repoPath, relPath);

          try {
            const content = await fs.readFile(absPath, "utf8");
            files[relPath] = content;
          } catch (err: unknown) {
            // If file doesn't exist, note it
            files[relPath] = `[File not found: ${err instanceof Error ? err.message : String(err)}]`;
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }]
        };
      }

      case "trm.endSession": {
        const p = req.params.arguments as SessionIdArgs;
        sessions.delete(p.sessionId);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
      }

      case "trm.validateCandidate": {
        const p = req.params.arguments as { sessionId: string; candidate: any };
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const validation = await validateCandidate(state.cfg.repoPath, p.candidate);
        return { content: [{ type: "text", text: JSON.stringify(validation, null, 2) }] };
      }

      case "trm.getSuggestions": {
        const p = req.params.arguments as SessionIdArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const last = state.history[state.history.length - 1];
        if (!last) {
          return { content: [{ type: "text", text: JSON.stringify({ suggestions: [], message: "No evaluations yet" }, null, 2) }] };
        }

        const suggestions = await generateSuggestions(state, last);
        return { content: [{ type: "text", text: JSON.stringify({ suggestions }, null, 2) }] };
      }

      case "trm.saveCheckpoint": {
        const p = req.params.arguments as SaveCheckpointArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const checkpointId = await saveCheckpoint(state, p.description);
        return { content: [{ type: "text", text: JSON.stringify({ checkpointId, message: "Checkpoint saved" }, null, 2) }] };
      }

      case "trm.restoreCheckpoint": {
        const p = req.params.arguments as RestoreCheckpointArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const result = await restoreCheckpoint(state, p.checkpointId);
        if (!result.success) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ message: "Checkpoint restored" }, null, 2) }] };
      }

      case "trm.listCheckpoints": {
        const p = req.params.arguments as ListCheckpointsArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

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

      case "trm.resetToBaseline": {
        const p = req.params.arguments as SessionIdArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        await resetToBaseline(state);
        return { content: [{ type: "text", text: JSON.stringify({ message: "Reset to baseline" }, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unhandled tool: ${req.params.name}` }] };
    }
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
});

await server.connect(transport);
console.error(pc.dim(`[mcp-trm-server] ready on stdio`));
