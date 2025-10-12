/**
 * Runtime validation utilities for MCP tool arguments.
 * Provides type-safe validation without relying on 'any' casts.
 */

/**
 * Validates that an object has a sessionId string property.
 */
export function validateSessionIdArg(args: unknown): args is { sessionId: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "sessionId" in args &&
    typeof (args as any).sessionId === "string"
  );
}

/**
 * Validates StartSessionArgs structure.
 */
export function validateStartSessionArg(args: unknown): args is {
  repoPath: string;
  halt: { maxSteps: number; passThreshold: number; patienceNoImprove: number };
  [key: string]: unknown;
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.repoPath === "string" &&
    typeof obj.halt === "object" &&
    obj.halt !== null &&
    typeof obj.halt.maxSteps === "number" &&
    typeof obj.halt.passThreshold === "number" &&
    typeof obj.halt.patienceNoImprove === "number"
  );
}

/**
 * Validates SubmitCandidateArgs structure.
 */
export function validateSubmitCandidateArg(args: unknown): args is {
  sessionId: string;
  candidate: unknown;
  [key: string]: unknown;
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.sessionId === "string" &&
    typeof obj.candidate === "object" &&
    obj.candidate !== null
  );
}

/**
 * Validates GetFileContentArgs structure.
 */
export function validateGetFileContentArg(args: unknown): args is {
  sessionId: string;
  paths: string[];
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.sessionId === "string" &&
    Array.isArray(obj.paths) &&
    obj.paths.every((p: unknown) => typeof p === "string")
  );
}

/**
 * Validates GetFileLinesArgs structure.
 */
export function validateGetFileLinesArg(args: unknown): args is {
  sessionId: string;
  file: string;
  startLine: number;
  endLine: number;
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.sessionId === "string" &&
    typeof obj.file === "string" &&
    typeof obj.startLine === "number" &&
    typeof obj.endLine === "number"
  );
}

/**
 * Validates SaveCheckpointArgs structure.
 */
export function validateSaveCheckpointArg(args: unknown): args is {
  sessionId: string;
  description?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.sessionId === "string" &&
    (obj.description === undefined || typeof obj.description === "string")
  );
}

/**
 * Validates RestoreCheckpointArgs structure.
 */
export function validateRestoreCheckpointArg(args: unknown): args is {
  sessionId: string;
  checkpointId: string;
} {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as any;

  return (
    typeof obj.sessionId === "string" &&
    typeof obj.checkpointId === "string"
  );
}

/**
 * Generic validation error message generator.
 */
export function validationError(toolName: string, expectedFields: string[]): string {
  return `Invalid arguments for ${toolName}. Expected fields: ${expectedFields.join(", ")}`;
}
