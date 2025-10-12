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
  CommandStatus,
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
  ParsedDiffFile,
  CandidateSnapshot,
  UndoLastCandidateArgs,
  GetFileLinesArgs,
  GetFileLinesResponse,
  SuggestFixArgs,
  FixSuggestion
} from "./types.js";

// Import constants
import {
  MAX_FILE_SIZE,
  MAX_CANDIDATE_FILES,
  MAX_RATIONALE_LENGTH,
  SCORE_IMPROVEMENT_EPSILON,
  MAX_HINT_LINES,
  MAX_FEEDBACK_ITEMS,
  MAX_FILE_READ_PATHS,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_LINT_TIMEOUT_MIN_SEC,
  DEFAULT_WEIGHT_BUILD,
  DEFAULT_WEIGHT_TEST,
  DEFAULT_WEIGHT_LINT,
  DEFAULT_WEIGHT_PERF,
  DEFAULT_MIN_STEPS,
  DEFAULT_EMA_ALPHA,
  LINT_TIMEOUT_DIVISOR,
  FIRST_STEP
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

// Import mode suggestion utilities
import { suggestOptimalMode, suggestModeFromHistory } from "./utils/mode-suggestion.js";

// Import error context utilities
import { correlateErrorsToChanges, generateErrorSuggestions, detectCascadingErrors } from "./utils/error-context.js";

// Import parser utilities
import { parseTestOutput, parseUnifiedDiff } from "./utils/parser.js";
import { parseTypeScriptErrors, formatTypeScriptError, groupRelatedErrors } from "./utils/ts-error-parser.js";

// Import patcher modules
import { customPatch } from "./patcher/custom-patcher.js";
import { applyEditOperations } from "./patcher/edit-operations.js";
import { applyCandidate, applyImprovedCandidate, validateCandidate } from "./patcher/candidate.js";

// Import analyzer modules
import { analyzeCodeFile, analyzeCodeFileEnhanced } from "./analyzer/code-analyzer.js";
import { generateSuggestions } from "./analyzer/suggestions.js";

// Import state management modules
import { saveCheckpoint, restoreCheckpoint, autoCheckpoint } from "./state/checkpoints.js";
import { resetToBaseline } from "./state/baseline.js";

// Import fix generator utilities
import { generateFixCandidates } from "./utils/fix-generator.js";

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
  },
  {
    name: "trm.undoLastCandidate",
    description: "Undo the last candidate submission and restore previous file state. Rolls back to the state before the last submitCandidate call.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.getFileLines",
    description: "Read a specific line range from a file. Returns lines with line numbers for easy reference. Useful for reading large files incrementally without loading entire content.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        file: { type: "string", description: "Relative path to file" },
        startLine: { type: "number", description: "Starting line number (1-based, inclusive)" },
        endLine: { type: "number", description: "Ending line number (1-based, inclusive)" }
      },
      required: ["sessionId", "file", "startLine", "endLine"]
    }
  },
  {
    name: "trm.suggestFix",
    description: "Generate actionable fix candidates based on error analysis from the last evaluation. Returns ready-to-apply candidates that can be directly submitted via trm.submitCandidate. Analyzes TypeScript errors, test failures, and lint issues to provide concrete fix suggestions.",
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
          timeoutSec: p.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
          weights: {
            build: p.weights?.build ?? DEFAULT_WEIGHT_BUILD,
            test: p.weights?.test ?? DEFAULT_WEIGHT_TEST,
            lint: p.weights?.lint ?? DEFAULT_WEIGHT_LINT,
            perf: p.weights?.perf ?? DEFAULT_WEIGHT_PERF
          },
          halt: {
            maxSteps: p.halt.maxSteps,
            passThreshold: p.halt.passThreshold,
            patienceNoImprove: p.halt.patienceNoImprove,
            minSteps: p.halt.minSteps ?? DEFAULT_MIN_STEPS
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

        // Validate commands before starting session and track their status
        const warnings: string[] = [];
        const commandStatus = {
          build: "unknown" as CommandStatus,
          test: "unknown" as CommandStatus,
          lint: "unknown" as CommandStatus,
          bench: "unknown" as CommandStatus
        };

        const commandChecks = [
          { name: "buildCmd", cmd: cfg.buildCmd, statusKey: "build" as const },
          { name: "testCmd", cmd: cfg.testCmd, statusKey: "test" as const },
          { name: "lintCmd", cmd: cfg.lintCmd, statusKey: "lint" as const },
          { name: "benchCmd", cmd: cfg.benchCmd, statusKey: "bench" as const }
        ];

        for (const check of commandChecks) {
          if (check.cmd) {
            try {
              const result = await runCmd(check.cmd, cfg.repoPath, 5000);
              if (!result.ok && (result.stderr.includes("Missing script") || result.stderr.includes("command not found"))) {
                commandStatus[check.statusKey] = "unavailable";
                // Don't add warnings for unavailable commands - they're expected
              } else {
                commandStatus[check.statusKey] = "available";
              }
            } catch (err) {
              commandStatus[check.statusKey] = "unknown";
              warnings.push(`${check.name} "${check.cmd}" validation failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            commandStatus[check.statusKey] = "unavailable";
          }
        }

        // Run preflight validation if requested
        let preflightResults: any = undefined;
        if (p.preflight) {
          preflightResults = {
            repoStatus: {
              gitRepo: !!baselineCommit,
              uncommittedChanges: false
            },
            commands: {
              build: { status: commandStatus.build, estimatedTime: "unknown" },
              test: { status: commandStatus.test },
              lint: { status: commandStatus.lint },
              bench: { status: commandStatus.bench }
            },
            initialBuild: undefined as any
          };

          // Check for uncommitted changes
          if (baselineCommit) {
            try {
              const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: cfg.repoPath });
              preflightResults.repoStatus.uncommittedChanges = stdout.trim().length > 0;
            } catch {
              // Ignore git status errors
            }
          }

          // Run initial build to establish baseline (if build command available)
          if (cfg.buildCmd && commandStatus.build === "available") {
            const buildStartTime = Date.now();
            const initialBuild = await runCmd(cfg.buildCmd, cfg.repoPath, cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
            const buildTime = ((Date.now() - buildStartTime) / 1000).toFixed(1);

            preflightResults.commands.build.estimatedTime = `${buildTime}s`;
            preflightResults.initialBuild = {
              success: initialBuild.ok,
              warnings: initialBuild.ok && initialBuild.stdout.includes("warning") ? ["Build succeeded with warnings"] : []
            };

            // Parse warnings from build output if available
            if (initialBuild.ok) {
              const warningMatches = initialBuild.stdout.match(/(\d+)\s+warning/);
              if (warningMatches) {
                preflightResults.initialBuild.warnings.push(`${warningMatches[1]} compiler warnings detected`);
              }
            }
          }
        }

        const state: SessionState = {
          id,
          cfg,
          createdAt: Date.now(),
          step: 0,
          bestScore: 0,
          emaScore: 0,
          emaAlpha: p.emaAlpha ?? DEFAULT_EMA_ALPHA,
          noImproveStreak: 0,
          history: [],
          zNotes: p.zNotes || undefined,
          mode: (p as ImprovedStartSessionArgs).mode ?? "cumulative",
          checkpoints: new Map(),
          baselineCommit,
          modifiedFiles: new Set(),
          fileSnapshots: new Map(),
          commandStatus,
          iterationContexts: [],
          candidateSnapshots: [] // Phase 3: Store candidate data for undo functionality
        };
        sessions.set(id, state);

        const response: any = {
          sessionId: id,
          message: "TRM session started"
        };
        if (warnings.length > 0) {
          response.warnings = warnings;
        }
        if (preflightResults) {
          response.preflightResults = preflightResults;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }]
        };
      }

      case "trm.submitCandidate": {
        const p = req.params.arguments as SubmitCandidateArgs;
        const state = sessions.get(p.sessionId);
        if (!state) {
          return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };
        }

        // Extract files being modified
        const candidate = p.candidate as any;
        const filesBeingModified: string[] = [];
        if (candidate.mode === "diff") {
          filesBeingModified.push(...candidate.changes.map((c: any) => c.path));
        } else if (candidate.mode === "patch") {
          const parsed = parseUnifiedDiff(candidate.patch);
          filesBeingModified.push(...parsed.map(d => d.file));
        } else if (candidate.mode === "files") {
          filesBeingModified.push(...candidate.files.map((f: any) => f.path));
        } else if (candidate.mode === "modify") {
          filesBeingModified.push(...candidate.changes.map((c: any) => c.file));
        }

        // Check for stale context warnings
        const staleContextWarnings: string[] = [];
        for (const file of filesBeingModified) {
          if (state.modifiedFiles.has(file)) {
            // File was modified before - check if context is fresh
            if (!state.fileSnapshots.has(file)) {
              staleContextWarnings.push(
                `⚠️  ${file} was modified in step ${state.step - 1} but context not refreshed. Use trm.getFileContent to avoid patch failures.`
              );
            }
          }
        }

        // Phase 3: Save candidate snapshot BEFORE applying changes (for undo functionality)
        const filesBeforeChange = new Map<string, string>();
        for (const file of filesBeingModified) {
          try {
            const absPath = path.resolve(state.cfg.repoPath, file);
            const content = await fs.readFile(absPath, "utf8");
            filesBeforeChange.set(file, content);
          } catch (err) {
            // File might not exist yet (for create mode) - that's ok
            filesBeforeChange.set(file, ""); // Empty string indicates file didn't exist
          }
        }

        // Apply candidate - handle both legacy and improved modes
        if (candidate.mode === "create" || candidate.mode === "modify") {
          const result = await applyImprovedCandidate(state.cfg.repoPath, candidate);
          if (!result.success) {
            throw new Error(`Candidate application failed:\n${JSON.stringify(result.errors, null, 2)}`);
          }
        } else {
          await applyCandidate(state.cfg.repoPath, p.candidate);
        }

        // Track modified files and automatically refresh their snapshots
        for (const file of filesBeingModified) {
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
        if (typeof p.rationale === "string" && p.rationale.trim().length) {
          // Keep only the latest rationale (TRM z feature)
          state.zNotes = p.rationale.slice(0, MAX_RATIONALE_LENGTH);
        }

        // Evaluate (skip unavailable commands)
        state.step += 1;
        const tSec = state.cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
        // Lint timeout is half of main timeout, with a minimum threshold
        const lintTimeoutSec = Math.max(DEFAULT_LINT_TIMEOUT_MIN_SEC, tSec / LINT_TIMEOUT_DIVISOR);

        // Only run available commands
        const build = state.commandStatus.build !== "unavailable"
          ? await runCmd(state.cfg.buildCmd, state.cfg.repoPath, tSec)
          : { ok: true, stdout: "", stderr: "", exitCode: 0 }; // Skip if unavailable

        const test = state.commandStatus.test !== "unavailable"
          ? await runCmd(state.cfg.testCmd, state.cfg.repoPath, tSec)
          : { ok: true, stdout: "", stderr: "", exitCode: 0 };

        const lint = state.commandStatus.lint !== "unavailable"
          ? await runCmd(state.cfg.lintCmd, state.cfg.repoPath, lintTimeoutSec)
          : { ok: true, stdout: "", stderr: "", exitCode: 0 };

        const bench = state.commandStatus.bench !== "unavailable"
          ? await runCmd(state.cfg.benchCmd, state.cfg.repoPath, tSec)
          : { ok: true, stdout: "", stderr: "", exitCode: 0 };

        const testParsed = state.cfg.testCmd && state.commandStatus.test !== "unavailable"
          ? parseTestOutput(test.stdout || test.stderr || "")
          : null;

        const score = scoreFromSignals(state, {
          buildOk: build.ok,
          lintOk: lint.ok,
          tests: testParsed ? { passed: testParsed.passed, total: testParsed.total } : undefined,
          perf: state.cfg.benchCmd && state.commandStatus.bench !== "unavailable"
            ? { value: parseFloat((bench.stdout || bench.stderr).match(/([\d.]+)$/)?.[1] || "NaN") }
            : undefined
        });

        // EMA
        state.emaScore = state.step === FIRST_STEP ? score
          : (state.emaAlpha * state.emaScore + (1 - state.emaAlpha) * score);

        // Improvement tracking
        if (score > state.bestScore + SCORE_IMPROVEMENT_EPSILON) {
          state.bestScore = score;
          state.noImproveStreak = 0;
        } else {
          state.noImproveStreak += 1;
        }

        // Track this iteration's context for error correlation
        state.iterationContexts.push({
          step: state.step,
          filesModified: [...filesBeingModified],
          mode: candidate.mode,
          success: build.ok && (!testParsed || testParsed.passed === testParsed.total) && lint.ok
        });

        const feedback: string[] = [];
        // Add stale context warnings first (high priority)
        feedback.push(...staleContextWarnings);

        // Use error context correlation for failures
        if (state.commandStatus.build !== "unavailable" && !build.ok) {
          feedback.push("Build failed – fix compilation/type errors.");

          // Correlate errors to recent changes
          const errorContext = correlateErrorsToChanges(
            build.stderr + "\n" + build.stdout,
            state.iterationContexts.slice(-5), // Last 5 iterations
            state.step
          );

          // Add correlation analysis
          feedback.push(...errorContext.analysis);

          // Add actionable suggestions
          const suggestions = generateErrorSuggestions("build", errorContext.likelyCulprit);
          feedback.push(...suggestions);

          // Parse TypeScript errors and add intelligent suggestions
          const tsErrors = parseTypeScriptErrors(build.stderr + "\n" + build.stdout);
          if (tsErrors.length > 0) {
            // Group related errors to reduce noise
            const grouped = groupRelatedErrors(tsErrors);

            // Add up to 3 most relevant errors with suggestions
            let errorCount = 0;
            for (const [, errors] of grouped) {
              if (errorCount >= 3) break;

              const firstError = errors[0];
              if (firstError.suggestion) {
                feedback.push(formatTypeScriptError(firstError));
                errorCount++;
              }
            }

            // Add count summary if there are more errors
            if (tsErrors.length > errorCount) {
              feedback.push(`   (${tsErrors.length - errorCount} more TypeScript errors)`);
            }
          }
        }
        if (state.cfg.testCmd && state.commandStatus.test !== "unavailable") {
          if (!testParsed) {
            feedback.push("Tests output not parsed – prefer JSON reporter or include summary lines.");
          } else {
            feedback.push(`Tests: ${testParsed.passed}/${testParsed.total} passed.`);
            if (testParsed.failed > 0) feedback.push(`There are ${testParsed.failed} failing tests.`);
          }
        }
        if (state.cfg.lintCmd && state.commandStatus.lint !== "unavailable" && !lint.ok) {
          feedback.push("Lint failed – fix style/static-analysis issues.");
        }
        if (state.cfg.benchCmd && state.commandStatus.bench !== "unavailable" && bench.ok) {
          feedback.push("Benchmark executed – try improving critical hot paths while keeping correctness.");
        }

        const hintLines = [
          ...(state.commandStatus.build !== "unavailable" ? diffHints(build.stderr, build.stdout) : []),
          ...(state.commandStatus.test !== "unavailable" ? diffHints(test.stderr, test.stdout) : []),
          ...(state.commandStatus.lint !== "unavailable" ? diffHints(lint.stderr, lint.stdout) : [])
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

        // Phase 3: Store candidate snapshot AFTER evaluation (for undo functionality)
        const candidateSnapshot: CandidateSnapshot = {
          step: state.step,
          candidate: candidate,
          rationale: p.rationale,
          filesBeforeChange: filesBeforeChange,
          evalResult: evalResult,
          timestamp: Date.now()
        };
        state.candidateSnapshots.push(candidateSnapshot);

        // Generate mode suggestion based on candidate structure
        const modeSuggestion = suggestOptimalMode(candidate);

        // Also check history-based suggestions if there are recent failures
        if (!modeSuggestion && state.history.length >= 2) {
          const recentFailures = state.history.slice(-3).filter(h => !h.okBuild).map(h => ({
            mode: "unknown", // We don't track mode in history yet, but could enhance this
            error: h.feedback.find(f => f.includes("failed"))
          }));

          if (recentFailures.length > 0) {
            const historyBasedSuggestion = suggestModeFromHistory(candidate.mode, recentFailures);
            if (historyBasedSuggestion) {
              evalResult.modeSuggestion = historyBasedSuggestion;
            }
          }
        }

        // Add suggestion to eval result if generated
        if (modeSuggestion) {
          evalResult.modeSuggestion = modeSuggestion;
        }

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
          feedback: evalResult.feedback,
          modeSuggestion: evalResult.modeSuggestion
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

        const files: Record<string, { content: string; metadata: { lineCount: number; sizeBytes: number; lastModified: string } }> = {};
        for (const relPath of p.paths) {
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

      case "trm.endSession": {
        const p = req.params.arguments as SessionIdArgs;
        sessions.delete(p.sessionId);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
      }

      case "trm.validateCandidate": {
        const p = req.params.arguments as { sessionId: string; candidate: CreateSubmission | ModifySubmission };
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

      case "trm.undoLastCandidate": {
        const p = req.params.arguments as UndoLastCandidateArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        // Check if there are snapshots to undo
        if (state.candidateSnapshots.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "No candidate to undo" }, null, 2) }] };
        }

        // Get the last snapshot
        const lastSnapshot = state.candidateSnapshots.pop()!;

        // Restore file contents from before the candidate was applied
        for (const [file, contentBefore] of lastSnapshot.filesBeforeChange.entries()) {
          const absPath = path.resolve(state.cfg.repoPath, file);
          try {
            if (contentBefore === "") {
              // File didn't exist before - delete it
              await fs.remove(absPath);
            } else {
              // Restore previous content
              await fs.writeFile(absPath, contentBefore, "utf8");
            }
          } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({
              error: `Failed to restore file ${file}: ${err instanceof Error ? err.message : String(err)}`
            }, null, 2) }] };
          }
        }

        // Roll back state
        state.step = lastSnapshot.step - 1; // Go back to previous step
        state.history.pop(); // Remove last eval result

        // Recalculate best score and EMA from remaining history
        if (state.history.length > 0) {
          state.bestScore = Math.max(...state.history.map(h => h.score));
          state.emaScore = state.history[state.history.length - 1].emaScore;

          // Recalculate noImproveStreak
          let streak = 0;
          for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].score > state.bestScore + SCORE_IMPROVEMENT_EPSILON) {
              break;
            }
            streak++;
          }
          state.noImproveStreak = streak;
        } else {
          state.bestScore = 0;
          state.emaScore = 0;
          state.noImproveStreak = 0;
        }

        // Remove iteration context
        if (state.iterationContexts.length > 0) {
          state.iterationContexts.pop();
        }

        // Refresh file snapshots for the restored files
        for (const [file, contentBefore] of lastSnapshot.filesBeforeChange.entries()) {
          if (contentBefore !== "") {
            state.fileSnapshots.set(file, contentBefore);
          } else {
            state.fileSnapshots.delete(file);
          }
        }

        const response = {
          message: `Undone candidate from step ${lastSnapshot.step}`,
          currentStep: state.step,
          score: state.history.length > 0 ? state.history[state.history.length - 1].score : 0,
          emaScore: state.emaScore,
          filesRestored: Array.from(lastSnapshot.filesBeforeChange.keys())
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }

      case "trm.getFileLines": {
        const p = req.params.arguments as GetFileLinesArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        // Validate path
        validateSafePath(state.cfg.repoPath, p.file);
        const absPath = path.resolve(state.cfg.repoPath, p.file);

        // Validate line range
        if (p.startLine < 1 || p.endLine < 1) {
          return { content: [{ type: "text", text: JSON.stringify({
            error: "Line numbers must be >= 1",
            startLine: p.startLine,
            endLine: p.endLine
          }, null, 2) }] };
        }

        if (p.startLine > p.endLine) {
          return { content: [{ type: "text", text: JSON.stringify({
            error: "startLine must be <= endLine",
            startLine: p.startLine,
            endLine: p.endLine
          }, null, 2) }] };
        }

        try {
          // Read file content
          const content = await fs.readFile(absPath, "utf8");
          const allLines = content.split('\n');
          const lineCount = allLines.length;

          // Validate that startLine is within bounds
          if (p.startLine > lineCount) {
            return { content: [{ type: "text", text: JSON.stringify({
              error: `startLine ${p.startLine} out of range (file has ${lineCount} lines)`,
              lineCount
            }, null, 2) }] };
          }

          // Extract requested range (1-based to 0-based conversion)
          const start = p.startLine - 1;
          const end = Math.min(p.endLine, lineCount); // Clamp to actual line count
          const selectedLines = allLines.slice(start, end);

          // Format lines with line numbers
          const formattedLines = selectedLines.map((line, idx) => {
            const lineNum = p.startLine + idx;
            return `${lineNum}: ${line}`;
          });

          const response: GetFileLinesResponse = {
            file: p.file,
            lines: formattedLines,
            lineCount: lineCount
          };

          return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        } catch (err: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
            file: p.file
          }, null, 2) }] };
        }
      }

      case "trm.suggestFix": {
        const p = req.params.arguments as SuggestFixArgs;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        // Check if there's an evaluation to analyze
        if (state.history.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({
            suggestions: [],
            message: "No evaluations yet - run submitCandidate first"
          }, null, 2) }] };
        }

        // Get the last evaluation
        const lastEval = state.history[state.history.length - 1];

        // Check if there are errors to fix
        if (lastEval.okBuild && (!lastEval.tests || lastEval.tests.failed === 0) && lastEval.okLint) {
          return { content: [{ type: "text", text: JSON.stringify({
            suggestions: [],
            message: "No errors detected in last evaluation"
          }, null, 2) }] };
        }

        // Generate fix candidates
        const suggestions = await generateFixCandidates(state, lastEval);

        return { content: [{ type: "text", text: JSON.stringify({
          suggestions,
          message: suggestions.length > 0 ? `Generated ${suggestions.length} fix candidate(s)` : "No actionable fixes could be generated"
        }, null, 2) }] };
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
