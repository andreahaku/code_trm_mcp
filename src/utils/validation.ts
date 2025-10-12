/**
 * Validation utilities for the TRM MCP server.
 */

import fs from "fs-extra";
import path from "path";
import type { StartSessionArgs } from "../types.js";

/**
 * Validate that a path is safe and within the allowed repository.
 * Prevents path traversal attacks.
 */
export function validateSafePath(repoPath: string, targetPath: string): void {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedTarget = path.resolve(repoPath, targetPath);

  if (!resolvedTarget.startsWith(resolvedRepo + path.sep) && resolvedTarget !== resolvedRepo) {
    throw new Error(`Path traversal detected: ${targetPath} escapes repository boundary`);
  }
}

/**
 * Validate startSession arguments.
 */
export async function validateStartSessionArgs(args: StartSessionArgs): Promise<void> {
  // Validate repoPath exists and is a directory
  const stat = await fs.stat(args.repoPath).catch(() => null);
  if (!stat) {
    throw new Error(`Repository path does not exist: ${args.repoPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${args.repoPath}`);
  }

  // Validate weights
  if (args.weights) {
    const { build, test, lint, perf } = args.weights;
    if (build !== undefined && (build < 0 || build > 1)) {
      throw new Error(`Invalid weight for build: ${build} (must be in [0,1])`);
    }
    if (test !== undefined && (test < 0 || test > 1)) {
      throw new Error(`Invalid weight for test: ${test} (must be in [0,1])`);
    }
    if (lint !== undefined && (lint < 0 || lint > 1)) {
      throw new Error(`Invalid weight for lint: ${lint} (must be in [0,1])`);
    }
    if (perf !== undefined && (perf < 0 || perf > 1)) {
      throw new Error(`Invalid weight for perf: ${perf} (must be in [0,1])`);
    }
  }

  // Validate halt parameters
  if (args.halt.maxSteps < 1) {
    throw new Error(`maxSteps must be >= 1, got ${args.halt.maxSteps}`);
  }
  if (args.halt.passThreshold < 0 || args.halt.passThreshold > 1) {
    throw new Error(`passThreshold must be in [0,1], got ${args.halt.passThreshold}`);
  }
  if (args.halt.patienceNoImprove < 1) {
    throw new Error(`patienceNoImprove must be >= 1, got ${args.halt.patienceNoImprove}`);
  }
  if (args.halt.minSteps !== undefined && args.halt.minSteps < 1) {
    throw new Error(`minSteps must be >= 1, got ${args.halt.minSteps}`);
  }

  // Validate emaAlpha
  if (args.emaAlpha !== undefined && (args.emaAlpha < 0 || args.emaAlpha > 1)) {
    throw new Error(`emaAlpha must be in [0,1], got ${args.emaAlpha}`);
  }

  // Validate timeout
  if (args.timeoutSec !== undefined && args.timeoutSec < 1) {
    throw new Error(`timeoutSec must be >= 1, got ${args.timeoutSec}`);
  }
}

/**
 * Type guard to check if an error has expected execa properties.
 */
export function isExecaError(
  err: unknown
): err is { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; message?: string } {
  return (
    typeof err === 'object' && err !== null &&
    ('stdout' in err || 
     'stderr' in err || 
     'exitCode' in err || 
     'timedOut' in err)
  );
}

/**
 * Clamp a number to the range [0, 1].
 */
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Validate that a command string is not empty and safe to execute.
 */
export function validateCommand(cmd: string | undefined): void {
  if (cmd !== undefined && cmd.trim().length === 0) {
    throw new Error("Command cannot be empty");
  }
}

/**
 * Check if a path exists and is readable.
 */
export async function validatePathReadable(filepath: string): Promise<void> {
  try {
    await fs.access(filepath, fs.constants.R_OK);
  } catch {
    throw new Error(`Path is not readable: ${filepath}`);
  }
}
