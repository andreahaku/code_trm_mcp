/**
 * Candidate application logic for all submission modes.
 */

import fs from "fs-extra";
import path from "path";
import pc from "picocolors";
import type {
  EnhancedError,
  ValidationResult,
  CreateSubmission,
  ModifySubmission
} from "../types.js";
import { validateSafePath } from "../utils/validation.js";
import { parseUnifiedDiff } from "../utils/parser.js";
import { customPatch } from "./custom-patcher.js";
import { applyEditOperations } from "./edit-operations.js";
import {
  MAX_FILE_SIZE,
  MAX_CANDIDATE_FILES
} from "../constants.js";

/**
 * Apply candidate changes to the repository using custom patcher (for diffs) or direct writes (for files).
 * Validates file sizes and paths to prevent abuse.
 */
export async function applyCandidate(
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

/**
 * Apply improved candidate format (create/modify modes)
 */
export async function applyImprovedCandidate(
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
export async function validateCandidate(
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
