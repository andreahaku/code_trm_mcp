/**
 * Semantic edit operations for intuitive code modifications.
 */

import fs from "fs-extra";
import path from "path";
import type { EditOperation, EnhancedError } from "../types.js";
import { validateSafePath } from "../utils/validation.js";

/**
 * Apply semantic edit operations to a file
 */
export async function applyEditOperations(
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
