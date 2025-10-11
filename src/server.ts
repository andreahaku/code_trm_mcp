#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Tool, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import path from "path";
import { execa } from "execa";
import pc from "picocolors";

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

type SessionId = string;

// Tool argument types for type safety
type StartSessionArgs = {
  repoPath: string;
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  benchCmd?: string;
  timeoutSec?: number;
  weights?: {
    build?: number;
    test?: number;
    lint?: number;
    perf?: number;
  };
  halt: {
    maxSteps: number;
    passThreshold: number;
    patienceNoImprove: number;
    minSteps?: number;
  };
  emaAlpha?: number;
  zNotes?: string;
};

type SubmitCandidateArgs = {
  sessionId: string;
  candidate:
    | { mode: "diff"; changes: { path: string; diff: string }[] }
    | { mode: "patch"; patch: string }
    | { mode: "files"; files: { path: string; content: string }[] };
  rationale?: string;
};

type GetFileContentArgs = {
  sessionId: string;
  paths: string[];
};

type SessionIdArgs = {
  sessionId: string;
};

type SessionConfig = {
  repoPath: string;
  buildCmd?: string;       // e.g., "npm run build" or "tsc -p . --noEmit"
  testCmd?: string;        // e.g., "npm test --silent -- --reporter=json"
  lintCmd?: string;        // e.g., "npm run lint" or "eslint ."
  benchCmd?: string;       // optional perf
  timeoutSec?: number;     // per cmd timeout
  weights: {
    build: number; // 0..1
    test: number;  // 0..1
    lint: number;  // 0..1
    perf: number;  // 0..1
  };
  halt: {
    maxSteps: number;          // hard limit
    passThreshold: number;     // score to accept when tests pass
    patienceNoImprove: number; // steps without improvement
    minSteps?: number;         // optional minimum before halting
  };
};

type EvalResult = {
  okBuild?: boolean;
  okLint?: boolean;
  tests?: { passed: number; failed: number; total: number; raw?: string };
  perf?: { value: number; unit?: string }; // lower-is-better by default, configurable if needed
  score: number;           // 0..1
  emaScore: number;        // 0..1
  step: number;            // 1-based
  feedback: string[];      // compact actionable signals for LLM
  shouldHalt: boolean;
  reasons: string[];
};

type SessionState = {
  id: SessionId;
  cfg: SessionConfig;
  createdAt: number;
  step: number;
  bestScore: number;
  emaScore: number;
  emaAlpha: number; // e.g., 0.9
  noImproveStreak: number;
  history: EvalResult[];
  // TRM-like latent memo (optional); LLM may supply rationale here
  zNotes?: string;
  // perf baseline to normalize (best lower value)
  bestPerf?: number;
};

const sessions = new Map<SessionId, SessionState>();

// Constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_CANDIDATE_FILES = 100; // Maximum files in a single candidate

// ------------- helpers ----------------

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

/**
 * Validate that a path is safe and within the allowed repository.
 * Prevents path traversal attacks.
 */
function validateSafePath(repoPath: string, targetPath: string): void {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedTarget = path.resolve(repoPath, targetPath);
  
  if (!resolvedTarget.startsWith(resolvedRepo + path.sep) && resolvedTarget !== resolvedRepo) {
    throw new Error(`Path traversal detected: ${targetPath} escapes repository boundary`);
  }
}

/**
 * Validate startSession arguments.
 */
async function validateStartSessionArgs(args: StartSessionArgs): Promise<void> {
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
 * Parse a command string into program and arguments, respecting quotes.
 * Example: 'npm test --silent -- --reporter="json"' -> ['npm', 'test', '--silent', '--', '--reporter=json']
 */
function parseCommand(cmd: string): { bin: string; args: string[] } {
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

async function runCmd(cmd: string | undefined, cwd: string, timeoutSec: number): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  if (!cmd) return { ok: true, stdout: "", stderr: "", exitCode: 0 };

  try {
    const { bin, args } = parseCommand(cmd);
    const { stdout, stderr, exitCode } = await execa(bin, args, { cwd, timeout: timeoutSec * 1000, shell: false });
    return { ok: (exitCode ?? 0) === 0, stdout, stderr, exitCode: exitCode ?? 0 };
  } catch (err: any) {
    // Handle timeout specifically
    if (err.timedOut) {
      return { 
        ok: false, 
        stdout: err.stdout ?? "", 
        stderr: `Command timed out after ${timeoutSec}s\n${err.stderr ?? ""}`, 
        exitCode: -1 
      };
    }
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.exitCode ?? -1 };
  }
}

function parseTestOutput(raw: string): { passed: number; failed: number; total: number } | null {
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

function scoreFromSignals(state: SessionState, signals: {
  buildOk: boolean;
  lintOk: boolean;
  tests?: { passed: number; total: number };
  perf?: { value: number };
}): number {
  const w = state.cfg.weights;
  let sBuild = signals.buildOk ? 1 : 0;
  let sLint = signals.lintOk ? 1 : 0;

  let sTests = 0;
  if (signals.tests && signals.tests.total > 0) {
    sTests = clamp01(signals.tests.passed / signals.tests.total);
  } else if (state.cfg.testCmd) {
    // If tests expected but no parse, be conservative:
    sTests = 0;
  }

  // perf: if we have a bestPerf as lower-is-better baseline, normalize in (0,1]
  let sPerf = 0;
  if (signals.perf && isFinite(signals.perf.value)) {
    if (state.bestPerf === undefined) {
      state.bestPerf = signals.perf.value;
      sPerf = 1; // first observation is best so far
    } else {
      // normalize inversely: score = clamp(best/perf, 0..1)
      if (signals.perf.value <= 0) {
        sPerf = 0;
      } else {
        sPerf = clamp01(state.bestPerf / signals.perf.value);
        if (signals.perf.value < state.bestPerf) state.bestPerf = signals.perf.value;
      }
    }
  } else if (state.cfg.benchCmd) {
    // Expected perf but missing -> 0
    sPerf = 0;
  }

  const sumW = w.build + w.test + w.lint + w.perf || 1;
  const score = clamp01((w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumW);
  return score;
}

function shouldHalt(state: SessionState, last: EvalResult): { halt: boolean; reasons: string[] } {
  const r: string[] = [];
  const cfg = state.cfg.halt;
  const minSteps = cfg.minSteps ?? 1;

  const testsPass = last.tests && last.tests.total > 0 && last.tests.passed === last.tests.total;

  if (state.step >= minSteps && testsPass && last.score >= cfg.passThreshold) {
    r.push(`tests pass and score ${last.score.toFixed(3)} ≥ threshold ${cfg.passThreshold}`);
    return { halt: true, reasons: r };
  }

  if (state.noImproveStreak >= cfg.patienceNoImprove) {
    r.push(`no improvement for ${state.noImproveStreak} steps (patience=${cfg.patienceNoImprove})`);
    return { halt: true, reasons: r };
  }

  if (state.step >= cfg.maxSteps) {
    r.push(`reached max steps ${cfg.maxSteps}`);
    return { halt: true, reasons: r };
  }

  return { halt: false, reasons: [] };
}

function diffHints(stderr: string, stdout: string): string[] {
  const hints: string[] = [];
  const out = `${stdout}\n${stderr}`;
  // Compact actionable hints (non-exhaustive)
  const tsErrs = out.match(/^(.+:\d+:\d+ - error .+)$/gmi);
  if (tsErrs) hints.push(...tsErrs.slice(0, 10));
  const jestFail = out.match(/● .*? \((\d+)ms\)/g);
  if (jestFail) hints.push(...jestFail.slice(0, 10));
  const eslintErr = out.match(/error\s+.+\s+\(.+?\)/g);
  if (eslintErr) hints.push(...eslintErr.slice(0, 10));
  // Fallback generic lines
  if (hints.length === 0) {
    const lines = out.split(/\r?\n/).filter(l => l.trim().length && l.length < 240);
    hints.push(...lines.slice(0, 10));
  }
  return [...new Set(hints)];
}

async function applyCandidate(
  repoPath: string,
  candidate: { mode: "diff"; changes: { path: string; diff: string }[] } |
             { mode: "patch"; patch: string } |
             { mode: "files"; files: { path: string; content: string }[] }
) {
  if (candidate.mode === "diff") {
    // Apply multiple file diffs
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

      // Apply each diff individually using git apply
      await execa("git", ["apply", "--whitespace=fix"], { cwd: repoPath, input: change.diff });
    }
    return;
  } else if (candidate.mode === "patch") {
    // Validate patch size
    const sizeBytes = Buffer.byteLength(candidate.patch, 'utf8');
    if (sizeBytes > MAX_FILE_SIZE) {
      throw new Error(`Patch too large: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    }

    // apply unified diff using `git apply --whitespace=fix`
    await execa("git", ["apply", "--whitespace=fix"], { cwd: repoPath, input: candidate.patch });
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
          zNotes: p.zNotes || undefined
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
          state.zNotes = p.rationale.slice(0, 4000);
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
        if (score > state.bestScore + 1e-6) {
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
        ].slice(0, 12);

        const evalResult: EvalResult = {
          okBuild: build.ok,
          okLint: lint.ok,
          tests: testParsed ? { ...testParsed, raw: "" } : undefined,
          perf: state.cfg.benchCmd && isFinite(Number(bench.stdout)) ? { value: Number(bench.stdout) } : undefined,
          score,
          emaScore: state.emaScore,
          step: state.step,
          feedback: [...new Set([...feedback, ...hintLines])].slice(0, 16),
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

        if (p.paths.length > 50) {
          throw new Error(`Too many paths requested: ${p.paths.length} (max 50)`);
        }

        const files: Record<string, string> = {};
        for (const relPath of p.paths) {
          validateSafePath(state.cfg.repoPath, relPath);
          const absPath = path.resolve(state.cfg.repoPath, relPath);

          try {
            const content = await fs.readFile(absPath, "utf8");
            files[relPath] = content;
          } catch (err: any) {
            // If file doesn't exist, note it
            files[relPath] = `[File not found: ${err.message}]`;
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

      default:
        return { content: [{ type: "text", text: `Unhandled tool: ${req.params.name}` }] };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${String(err?.message ?? err)}` }] };
  }
});

await server.connect(transport);
console.error(pc.dim(`[mcp-trm-server] ready on stdio`));
