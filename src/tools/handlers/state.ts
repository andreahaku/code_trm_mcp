import type { SessionIdArgs } from "../../types.js";
import { shouldHalt } from "../../utils/scoring.js";
import { generateSuggestions } from "../../analyzer/suggestions.js";
import { sessions } from "../../shared/sessions.js";
import { unknownSessionError, successResponse } from "./lib/response-utils.js";

/**
 * Handler for trm.getState tool.
 * Returns current TRM state (scores, EMA, history summary).
 */
export async function handleGetState(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  const last = state.history[state.history.length - 1];
  return successResponse({
    sessionId: state.id,
    step: state.step,
    emaScore: state.emaScore,
    bestScore: state.bestScore,
    noImproveStreak: state.noImproveStreak,
    last,
    zNotes: state.zNotes
  });
}

/**
 * Handler for trm.shouldHalt tool.
 * Returns halting decision based on latest evaluation.
 */
export async function handleShouldHalt(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  const last = state.history[state.history.length - 1];
  if (!last) {
    return successResponse({ shouldHalt: false, reasons: ["no evaluations yet"] });
  }

  const decision = shouldHalt(state, last);
  return successResponse({ shouldHalt: decision.halt, reasons: decision.reasons });
}

/**
 * Handler for trm.getSuggestions tool.
 * Gets AI-powered suggestions for code improvements based on evaluation results and code analysis.
 */
export async function handleGetSuggestions(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return unknownSessionError(args.sessionId);
  }

  const last = state.history[state.history.length - 1];
  if (!last) {
    return successResponse({ suggestions: [], message: "No evaluations yet" });
  }

  const suggestions = await generateSuggestions(state, last);
  return successResponse({ suggestions });
}
