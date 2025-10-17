import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { translateParams } from "../param-translator.js";
import { handleStartSession, handleEndSession } from "./session.js";
import { handleSubmitCandidate, handleValidateCandidate, handleUndoLastCandidate } from "./candidate.js";
import { handleGetFileContent, handleGetFileLines } from "./file.js";
import { handleGetState, handleShouldHalt, handleGetSuggestions } from "./state.js";
import { handleSaveCheckpoint, handleRestoreCheckpoint, handleListCheckpoints } from "./checkpoint.js";
import { handleResetToBaseline } from "./baseline.js";
import { handleSuggestFix } from "./fix.js";
import { handleReviewPR } from "./pr-review.js";

/**
 * Handler registry for ultra-optimized schema (short tool names).
 * Translates short property names to original format before calling handlers.
 */
export async function handleToolCall(req: CallToolRequest) {
  try {
    // Translate parameters from short names to original names
    const translatedArgs = translateParams(req.params.arguments);

    switch (req.params.name) {
      // Session lifecycle
      case "trm.start":
        return await handleStartSession(translatedArgs);
      case "trm.end":
        return await handleEndSession(translatedArgs);

      // Candidate submission and validation
      case "trm.submit":
        return await handleSubmitCandidate(translatedArgs);
      case "trm.validate":
        return await handleValidateCandidate(translatedArgs);
      case "trm.undo":
        return await handleUndoLastCandidate(translatedArgs);

      // File operations
      case "trm.read":
        return await handleGetFileContent(translatedArgs);
      case "trm.lines":
        return await handleGetFileLines(translatedArgs);

      // State queries
      case "trm.state":
        return await handleGetState(translatedArgs);
      case "trm.halt":
        return await handleShouldHalt(translatedArgs);
      case "trm.suggest":
        return await handleGetSuggestions(translatedArgs);

      // Checkpoint management
      case "trm.save":
        return await handleSaveCheckpoint(translatedArgs);
      case "trm.restore":
        return await handleRestoreCheckpoint(translatedArgs);
      case "trm.list":
        return await handleListCheckpoints(translatedArgs);

      // Baseline reset
      case "trm.reset":
        return await handleResetToBaseline(translatedArgs);

      // AI-powered fixes
      case "trm.fix":
        return await handleSuggestFix(translatedArgs);

      // PR review
      case "trm.review":
        return await handleReviewPR(translatedArgs);

      default:
        return { content: [{ type: "text", text: `Unhandled tool: ${req.params.name}` }] };
    }
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
