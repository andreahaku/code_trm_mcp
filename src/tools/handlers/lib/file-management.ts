import fs from "fs-extra";
import path from "path";
import type { SessionState } from "../../../types.js";
import { parseUnifiedDiff } from "../../../utils/parser.js";

/**
 * Extracts the list of files being modified from a candidate submission.
 * Handles all candidate modes: diff, patch, files, modify, create.
 */
export function extractModifiedFiles(candidate: unknown): string[] {
  const files: string[] = [];
  const candidateAny = candidate as any;

  if (candidateAny.mode === "diff") {
    files.push(...candidateAny.changes.map((c: any) => c.path));
  } else if (candidateAny.mode === "patch") {
    const parsed = parseUnifiedDiff(candidateAny.patch);
    files.push(...parsed.map(d => d.file));
  } else if (candidateAny.mode === "files") {
    files.push(...candidateAny.files.map((f: any) => f.path));
  } else if (candidateAny.mode === "modify") {
    files.push(...candidateAny.changes.map((c: any) => c.file));
  } else if (candidateAny.mode === "create") {
    files.push(...candidateAny.files.map((f: any) => f.path));
  }

  return files;
}

/**
 * Creates a snapshot of files before changes are applied (for undo functionality).
 * Returns a map of file paths to their content (empty string indicates file didn't exist).
 */
export async function createFileSnapshot(
  repoPath: string,
  files: string[]
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  for (const file of files) {
    try {
      const absPath = path.resolve(repoPath, file);
      const content = await fs.readFile(absPath, "utf8");
      snapshot.set(file, content);
    } catch (err) {
      // File might not exist yet (for create mode) - that's ok
      snapshot.set(file, ""); // Empty string indicates file didn't exist
    }
  }

  return snapshot;
}

/**
 * Updates session state to track modified files and refresh their snapshots.
 * This ensures stale context warnings work correctly.
 */
export async function updateModifiedFilesTracking(
  state: SessionState,
  files: string[]
): Promise<void> {
  for (const file of files) {
    state.modifiedFiles.add(file);

    // Automatically refresh context after modification
    try {
      const absPath = path.resolve(state.cfg.repoPath, file);
      const content = await fs.readFile(absPath, "utf8");
      state.fileSnapshots.set(file, content);
    } catch (err) {
      // File might not exist (e.g., deleted) - that's ok
      state.fileSnapshots.delete(file);
    }
  }
}
