import fs from "fs-extra";
import path from "path";
import type {
  SubmitCandidateArgs,
  CreateSubmission,
  ModifySubmission,
  CandidateSnapshot,
  UndoLastCandidateArgs,
  EvalResult
} from "../../types.js";
import { parseUnifiedDiff } from "../../utils/parser.js";
import { parseTestOutput } from "../../utils/parser.js";
import { parseTypeScriptErrors, formatTypeScriptError, groupRelatedErrors } from "../../utils/ts-error-parser.js";
import { correlateErrorsToChanges, generateErrorSuggestions } from "../../utils/error-context.js";
import { suggestOptimalMode, suggestModeFromHistory } from "../../utils/mode-suggestion.js";
import { scoreFromSignals, shouldHalt, diffHints } from "../../utils/scoring.js";
import { runCmd } from "../../utils/command.js";
import { applyCandidate, applyImprovedCandidate, validateCandidate } from "../../patcher/candidate.js";
import {
  MAX_RATIONALE_LENGTH,
  SCORE_IMPROVEMENT_EPSILON,
  MAX_HINT_LINES,
  MAX_FEEDBACK_ITEMS,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_LINT_TIMEOUT_MIN_SEC,
  LINT_TIMEOUT_DIVISOR,
  FIRST_STEP
} from "../../constants.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.submitCandidate tool.
 * Applies candidate changes, runs evaluation, and returns feedback.
 */
export async function handleSubmitCandidate(args: SubmitCandidateArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  // Extract files being modified
  const candidate = args.candidate as any;
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
    await applyCandidate(state.cfg.repoPath, args.candidate);
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
  if (typeof args.rationale === "string" && args.rationale.trim().length) {
    // Keep only the latest rationale (TRM z feature)
    state.zNotes = args.rationale.slice(0, MAX_RATIONALE_LENGTH);
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
    rationale: args.rationale,
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

/**
 * Handler for trm.validateCandidate tool.
 * Validates candidate changes without applying them (dry-run).
 */
export async function handleValidateCandidate(args: { sessionId: string; candidate: CreateSubmission | ModifySubmission }) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const validation = await validateCandidate(state.cfg.repoPath, args.candidate);
  return { content: [{ type: "text", text: JSON.stringify(validation, null, 2) }] };
}

/**
 * Handler for trm.undoLastCandidate tool.
 * Undoes the last candidate submission and restores previous file state.
 */
export async function handleUndoLastCandidate(args: UndoLastCandidateArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

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
