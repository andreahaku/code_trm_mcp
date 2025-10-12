import type { SessionState, CommandResult } from "../../../types.js";
import { runCmd } from "../../../utils/command.js";
import { parseTestOutput } from "../../../utils/parser.js";
import { scoreFromSignals } from "../../../utils/scoring.js";
import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_LINT_TIMEOUT_MIN_SEC,
  LINT_TIMEOUT_DIVISOR,
  FIRST_STEP
} from "../../../constants.js";

/**
 * Results from running evaluation commands
 */
export interface EvaluationResults {
  build: CommandResult;
  test: CommandResult;
  lint: CommandResult;
  bench: CommandResult;
  testParsed: { passed: number; total: number; failed: number } | null;
  score: number;
}

/**
 * Runs all evaluation commands (build, test, lint, bench) and computes score.
 * Only runs commands that are available (not marked as unavailable).
 */
export async function runEvaluation(state: SessionState): Promise<EvaluationResults> {
  const tSec = state.cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const lintTimeoutSec = Math.max(DEFAULT_LINT_TIMEOUT_MIN_SEC, tSec / LINT_TIMEOUT_DIVISOR);

  // Only run available commands
  const build = state.commandStatus.build !== "unavailable"
    ? await runCmd(state.cfg.buildCmd, state.cfg.repoPath, tSec)
    : { ok: true, stdout: "", stderr: "", exitCode: 0 };

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

  return { build, test, lint, bench, testParsed, score };
}

/**
 * Updates session state with evaluation results (EMA, best score, improvement tracking).
 */
export function updateStateWithEvaluation(state: SessionState, score: number): void {
  // EMA
  state.emaScore = state.step === FIRST_STEP ? score
    : (state.emaAlpha * state.emaScore + (1 - state.emaAlpha) * score);

  // Improvement tracking
  const SCORE_IMPROVEMENT_EPSILON = 1e-6;
  if (score > state.bestScore + SCORE_IMPROVEMENT_EPSILON) {
    state.bestScore = score;
    state.noImproveStreak = 0;
  } else {
    state.noImproveStreak += 1;
  }
}
