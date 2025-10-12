import type { SuggestFixArgs } from "../../types.js";
import { generateFixCandidates } from "../../utils/fix-generator.js";
import { sessions } from "../../shared/sessions.js";

/**
 * Handler for trm.suggestFix tool.
 * Generates actionable fix candidates based on error analysis from the last evaluation.
 * Returns ready-to-apply candidates that can be directly submitted via trm.submitCandidate.
 */
export async function handleSuggestFix(args: SuggestFixArgs) {
  const state = sessions.get(args.sessionId);
  if (!state) {
    return { content: [{ type: "text", text: `Unknown session: ${args.sessionId}` }] };
  }

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
