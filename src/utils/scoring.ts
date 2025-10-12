/**
 * Scoring and halting policy logic for TRM.
 */

import type { SessionState, EvalResult } from "../types.js";
import { clamp01 } from "./validation.js";

/**
 * Compute normalized score from build/test/lint/perf signals.
 * Note: This function has a side effect of updating state.bestPerf for performance tracking.
 *
 * @param state - The session state (modified: bestPerf may be updated)
 * @param signals - Evaluation signals from various checks
 */
export function scoreFromSignals(state: SessionState, signals: {
  buildOk: boolean;
  lintOk: boolean;
  tests?: { passed: number; total: number };
  perf?: { value: number };
}): number {
  const w = state.cfg.weights;
  const sBuild = signals.buildOk ? 1 : 0;
  const sLint = signals.lintOk ? 1 : 0;

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

/**
 * Determine if the refinement loop should halt based on score, improvement, and step count.
 * Implements ACT-like adaptive halting policy.
 */
export function shouldHalt(state: SessionState, last: EvalResult): { halt: boolean; reasons: string[] } {
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

/**
 * Extract actionable error hints from command output (TypeScript, Jest, ESLint patterns).
 * Returns deduplicated hints limited to avoid overwhelming feedback.
 */
export function diffHints(stderr: string, stdout: string): string[] {
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
