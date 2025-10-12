import type { SessionIdArgs } from "../../types.js";
import { shouldHalt } from "../../utils/scoring.js";
import { generateSuggestions } from "../../analyzer/suggestions.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.getState tool.
 * Returns current TRM state (scores, EMA, history summary).
 */
export async function handleGetState(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

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

/**
 * Handler for trm.shouldHalt tool.
 * Returns halting decision based on latest evaluation.
 */
export async function handleShouldHalt(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const last = state.history[state.history.length - 1];
  if (!last) {
    return { content: [{ type: "text", text: JSON.stringify({ shouldHalt: false, reasons: ["no evaluations yet"] }, null, 2) }] };
  }

  const decision = shouldHalt(state, last);
  return { content: [{ type: "text", text: JSON.stringify({ shouldHalt: decision.halt, reasons: decision.reasons }, null, 2) }] };
}

/**
 * Handler for trm.getSuggestions tool.
 * Gets AI-powered suggestions for code improvements based on evaluation results and code analysis.
 */
export async function handleGetSuggestions(args: SessionIdArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

  const last = state.history[state.history.length - 1];
  if (!last) {
    return { content: [{ type: "text", text: JSON.stringify({ suggestions: [], message: "No evaluations yet" }, null, 2) }] };
  }

  const suggestions = await generateSuggestions(state, last);
  return { content: [{ type: "text", text: JSON.stringify({ suggestions }, null, 2) }] };
}
