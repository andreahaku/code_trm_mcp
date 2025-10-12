import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { handleStartSession, handleEndSession } from "./session.js";
import { handleSubmitCandidate, handleValidateCandidate, handleUndoLastCandidate } from "./candidate.js";
import { handleGetFileContent, handleGetFileLines } from "./file.js";
import { handleGetState, handleShouldHalt, handleGetSuggestions } from "./state.js";
import { handleSaveCheckpoint, handleRestoreCheckpoint, handleListCheckpoints } from "./checkpoint.js";
import { handleResetToBaseline } from "./baseline.js";
import { handleSuggestFix } from "./fix.js";

/**
 * Handler registry - routes tool calls to appropriate handlers.
 * Centralizes error handling and response formatting.
 */
export async function handleToolCall(req: CallToolRequest) {
  try {
    switch (req.params.name) {
      // Session lifecycle
      case "trm.startSession":
        return await handleStartSession(req.params.arguments as any);
      case "trm.endSession":
        return await handleEndSession(req.params.arguments as any);

      // Candidate submission and validation
      case "trm.submitCandidate":
        return await handleSubmitCandidate(req.params.arguments as any);
      case "trm.validateCandidate":
        return await handleValidateCandidate(req.params.arguments as any);
      case "trm.undoLastCandidate":
        return await handleUndoLastCandidate(req.params.arguments as any);

      // File operations
      case "trm.getFileContent":
        return await handleGetFileContent(req.params.arguments as any);
      case "trm.getFileLines":
        return await handleGetFileLines(req.params.arguments as any);

      // State queries
      case "trm.getState":
        return await handleGetState(req.params.arguments as any);
      case "trm.shouldHalt":
        return await handleShouldHalt(req.params.arguments as any);
      case "trm.getSuggestions":
        return await handleGetSuggestions(req.params.arguments as any);

      // Checkpoint management
      case "trm.saveCheckpoint":
        return await handleSaveCheckpoint(req.params.arguments as any);
      case "trm.restoreCheckpoint":
        return await handleRestoreCheckpoint(req.params.arguments as any);
      case "trm.listCheckpoints":
        return await handleListCheckpoints(req.params.arguments as any);

      // Baseline reset
      case "trm.resetToBaseline":
        return await handleResetToBaseline(req.params.arguments as any);

      // AI-powered fixes
      case "trm.suggestFix":
        return await handleSuggestFix(req.params.arguments as any);

      default:
        return { content: [{ type: "text", text: `Unhandled tool: ${req.params.name}` }] };
    }
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
