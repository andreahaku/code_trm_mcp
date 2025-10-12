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
import { suggestOptimalMode, suggestModeFromHistory } from "../../utils/mode-suggestion.js";
import { shouldHalt } from "../../utils/scoring.js";
import { applyCandidate, applyImprovedCandidate, validateCandidate } from "../../patcher/candidate.js";
import { MAX_RATIONALE_LENGTH, SCORE_IMPROVEMENT_EPSILON } from "../../constants.js";
import { sessions } from "../../shared/sessions.js";
import { runEvaluation, updateStateWithEvaluation } from "./lib/evaluation.js";
import { generateFeedback, generateStaleContextWarnings } from "./lib/feedback.js";
import { extractModifiedFiles, createFileSnapshot, updateModifiedFilesTracking } from "./lib/file-management.js";
import { unknownSessionError, successResponse } from "./lib/response-utils.js";

/**
 * Handler for trm.submitCandidate tool.
 * Applies candidate changes, runs evaluation, and returns feedback.
 */
export async function handleSubmitCandidate(args: SubmitCandidateArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  const candidate = args.candidate as any;

  // Extract files being modified
  const filesBeingModified = extractModifiedFiles(candidate);

  // Check for stale context warnings
  const staleContextWarnings = generateStaleContextWarnings(state, filesBeingModified);

  // Phase 3: Save candidate snapshot BEFORE applying changes (for undo functionality)
  const filesBeforeChange = await createFileSnapshot(state.cfg.repoPath, filesBeingModified);

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
  await updateModifiedFilesTracking(state, filesBeingModified);

  if (typeof args.rationale === "string" && args.rationale.trim().length) {
    // Keep only the latest rationale (TRM z feature)
    state.zNotes = args.rationale.slice(0, MAX_RATIONALE_LENGTH);
  }

  // Evaluate (skip unavailable commands)
  state.step += 1;
  const evalResults = await runEvaluation(state);

  // Update state with evaluation results
  updateStateWithEvaluation(state, evalResults.score);

  // Track this iteration's context for error correlation
  state.iterationContexts.push({
    step: state.step,
    filesModified: [...filesBeingModified],
    mode: candidate.mode,
    success: evalResults.build.ok &&
      (!evalResults.testParsed || evalResults.testParsed.passed === evalResults.testParsed.total) &&
      evalResults.lint.ok
  });

  // Generate feedback from evaluation results
  const feedback = generateFeedback(state, evalResults, staleContextWarnings);

  const evalResult: EvalResult = {
    okBuild: evalResults.build.ok,
    okLint: evalResults.lint.ok,
    tests: evalResults.testParsed ? { ...evalResults.testParsed, raw: "" } : undefined,
    perf: state.cfg.benchCmd && isFinite(Number(evalResults.bench.stdout))
      ? { value: Number(evalResults.bench.stdout) }
      : undefined,
    score: evalResults.score,
    emaScore: state.emaScore,
    step: state.step,
    feedback,
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

  return successResponse({
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
  });
}

/**
 * Handler for trm.validateCandidate tool.
 * Validates candidate changes without applying them (dry-run).
 */
export async function handleValidateCandidate(args: { sessionId: string; candidate: CreateSubmission | ModifySubmission }) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  const validation = await validateCandidate(state.cfg.repoPath, args.candidate);
  return successResponse(validation);
}

/**
 * Handler for trm.undoLastCandidate tool.
 * Undoes the last candidate submission and restores previous file state.
 */
export async function handleUndoLastCandidate(args: UndoLastCandidateArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  // Check if there are snapshots to undo
  if (state.candidateSnapshots.length === 0) {
    return successResponse({ error: "No candidate to undo" });
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
      return successResponse({
        error: `Failed to restore file ${file}: ${err instanceof Error ? err.message : String(err)}`
      });
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

  return successResponse({
    message: `Undone candidate from step ${lastSnapshot.step}`,
    currentStep: state.step,
    score: state.history.length > 0 ? state.history[state.history.length - 1].score : 0,
    emaScore: state.emaScore,
    filesRestored: Array.from(lastSnapshot.filesBeforeChange.keys())
  });
}
