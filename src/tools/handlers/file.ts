import fs from "fs-extra";
import path from "path";
import type { GetFileContentArgs, GetFileLinesArgs, GetFileLinesResponse } from "../../types.js";
import { validateSafePath } from "../../utils/validation.js";
import { MAX_FILE_READ_PATHS } from "../../constants.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.getFileContent tool.
 * Reads current content of files from the repository with metadata.
 */
export async function handleGetFileContent(args: GetFileContentArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  if (args.paths.length > MAX_FILE_READ_PATHS) {
    throw new Error(`Too many paths requested: ${args.paths.length} (max ${MAX_FILE_READ_PATHS})`);
  }

  const files: Record<string, { content: string; metadata: { lineCount: number; sizeBytes: number; lastModified: string } }> = {};
  for (const relPath of args.paths) {
    validateSafePath(state.cfg.repoPath, relPath);
    const absPath = path.resolve(state.cfg.repoPath, relPath);

    try {
      const content = await fs.readFile(absPath, "utf8");
      const stats = await fs.stat(absPath);

      // Calculate line count
      const lineCount = content.split('\n').length;

      files[relPath] = {
        content,
        metadata: {
          lineCount,
          sizeBytes: stats.size,
          lastModified: stats.mtime.toISOString()
        }
      };

      // Cache the snapshot for context staleness detection
      state.fileSnapshots.set(relPath, content);
    } catch (err: unknown) {
      // If file doesn't exist, note it with error metadata
      files[relPath] = {
        content: `[File not found: ${err instanceof Error ? err.message : String(err)}]`,
        metadata: {
          lineCount: 0,
          sizeBytes: 0,
          lastModified: new Date().toISOString()
        }
      };
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }]
  };
}

/**
 * Handler for trm.getFileLines tool.
 * Reads a specific line range from a file with line numbers.
 */
export async function handleGetFileLines(args: GetFileLinesArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  // Validate path
  validateSafePath(state.cfg.repoPath, args.file);
  const absPath = path.resolve(state.cfg.repoPath, args.file);

  // Validate line range
  if (args.startLine < 1 || args.endLine < 1) {
    return { content: [{ type: "text", text: JSON.stringify({
      error: "Line numbers must be >= 1",
      startLine: args.startLine,
      endLine: args.endLine
    }, null, 2) }] };
  }

  if (args.startLine > args.endLine) {
    return { content: [{ type: "text", text: JSON.stringify({
      error: "startLine must be <= endLine",
      startLine: args.startLine,
      endLine: args.endLine
    }, null, 2) }] };
  }

  try {
    // Read file content
    const content = await fs.readFile(absPath, "utf8");
    const allLines = content.split('\n');
    const lineCount = allLines.length;

    // Validate that startLine is within bounds
    if (args.startLine > lineCount) {
      return { content: [{ type: "text", text: JSON.stringify({
        error: `startLine ${args.startLine} out of range (file has ${lineCount} lines)`,
        lineCount
      }, null, 2) }] };
    }

    // Extract requested range (1-based to 0-based conversion)
    const start = args.startLine - 1;
    const end = Math.min(args.endLine, lineCount); // Clamp to actual line count
    const selectedLines = allLines.slice(start, end);

    // Format lines with line numbers
    const formattedLines = selectedLines.map((line, idx) => {
      const lineNum = args.startLine + idx;
      return `${lineNum}: ${line}`;
    });

    const response: GetFileLinesResponse = {
      file: args.file,
      lines: formattedLines,
      lineCount: lineCount
    };

    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  } catch (err: unknown) {
    return { content: [{ type: "text", text: JSON.stringify({
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      file: args.file
    }, null, 2) }] };
  }
}
