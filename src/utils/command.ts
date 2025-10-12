/**
 * Command parsing and execution utilities.
 */

import { execa } from "execa";
import type { CommandResult } from "../types.js";
import { isExecaError } from "./validation.js";

/**
 * Parse a command string into program and arguments, respecting quotes.
 * Example: 'npm test --silent -- --reporter="json"' -> ['npm', 'test', '--silent', '--', '--reporter=json']
 */
export function parseCommand(cmd: string): { bin: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if ((char === '"' || char === "'") && (!inQuote || quoteChar === char)) {
      if (inQuote && quoteChar === char) {
        inQuote = false;
        quoteChar = "";
      } else if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      }
    } else if (char === " " && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);

  if (inQuote) {
    throw new Error(`Unclosed quote in command: ${cmd}`);
  }

  if (tokens.length === 0) throw new Error("Empty command");
  const [bin, ...args] = tokens;
  return { bin, args };
}

/**
 * Execute a command with timeout and error handling.
 * Returns undefined command as success with empty output.
 */
export async function runCmd(cmd: string | undefined, cwd: string, timeoutSec: number): Promise<CommandResult> {
  if (!cmd) return { ok: true, stdout: "", stderr: "", exitCode: 0 };

  try {
    const { bin, args } = parseCommand(cmd);
    const { stdout, stderr, exitCode } = await execa(bin, args, { cwd, timeout: timeoutSec * 1000, shell: false });
    return { ok: (exitCode ?? 0) === 0, stdout, stderr, exitCode: exitCode ?? 0 };
  } catch (err: unknown) {
    // Handle timeout specifically
    if (isExecaError(err) && err.timedOut) {
      return {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: `Command timed out after ${timeoutSec}s\n${err.stderr ?? ""}`,
        exitCode: -1
      };
    }
    if (isExecaError(err)) {
      return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.exitCode ?? -1 };
    }
    // Fallback for unexpected errors
    return { ok: false, stdout: "", stderr: String(err), exitCode: -1 };
  }
}
