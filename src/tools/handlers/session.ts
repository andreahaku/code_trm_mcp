import { v4 as uuidv4 } from "uuid";
import path from "path";
import { execa } from "execa";
import type {
  SessionId,
  StartSessionArgs,
  SessionIdArgs,
  SessionConfig,
  SessionState,
  CommandStatus,
  ImprovedStartSessionArgs
} from "../../types.js";
import { validateStartSessionArgs } from "../../utils/validation.js";
import { runCmd } from "../../utils/command.js";
import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_WEIGHT_BUILD,
  DEFAULT_WEIGHT_TEST,
  DEFAULT_WEIGHT_LINT,
  DEFAULT_WEIGHT_PERF,
  DEFAULT_MIN_STEPS,
  DEFAULT_EMA_ALPHA
} from "../../constants.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.startSession tool.
 * Initializes a TRM session on a local repository with evaluation commands and halting policy.
 */
export async function handleStartSession(args: StartSessionArgs) {
  // Validate input arguments
  await validateStartSessionArgs(args);

  const id: SessionId = uuidv4();
  const cfg: SessionConfig = {
    repoPath: path.resolve(args.repoPath),
    buildCmd: args.buildCmd,
    testCmd: args.testCmd,
    lintCmd: args.lintCmd,
    benchCmd: args.benchCmd,
    timeoutSec: args.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    weights: {
      build: args.weights?.build ?? DEFAULT_WEIGHT_BUILD,
      test: args.weights?.test ?? DEFAULT_WEIGHT_TEST,
      lint: args.weights?.lint ?? DEFAULT_WEIGHT_LINT,
      perf: args.weights?.perf ?? DEFAULT_WEIGHT_PERF
    },
    halt: {
      maxSteps: args.halt.maxSteps,
      passThreshold: args.halt.passThreshold,
      patienceNoImprove: args.halt.patienceNoImprove,
      minSteps: args.halt.minSteps ?? DEFAULT_MIN_STEPS
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
  if ((args as any).preflight) {
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
    emaAlpha: args.emaAlpha ?? DEFAULT_EMA_ALPHA,
    noImproveStreak: 0,
    history: [],
    zNotes: args.zNotes || undefined,
    mode: (args as ImprovedStartSessionArgs).mode ?? "cumulative",
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

/**
 * Handler for trm.endSession tool.
 * Ends and removes a TRM session.
 */
export async function handleEndSession(args: SessionIdArgs) {
  sessions.delete(args.sessionId);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }] };
}
