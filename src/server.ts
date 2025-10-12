#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pc from "picocolors";

// Import tool schemas and handler registry
import { tools } from "./tools/schemas.js";
import { handleToolCall } from "./tools/handlers/index.js";

/**
 * TRM-inspired MCP server for recursive code refinement.
 *
 * Design:
 * - The LLM client (Claude Code / Cursor / Codex CLI) proposes code changes.
 * - This server evaluates candidates (build/test/lint/bench), computes scores,
 *   tracks EMA and improvement deltas, and exposes a halting policy (ACT-like).
 * - State: y=current candidate (implicit in workspace files), z=rationale/notes,
 *   history of evaluations, EMA of score.
 *
 * Tools:
 *  - trm.startSession        : init session on a repo path + commands to run
 *  - trm.submitCandidate     : apply candidate changes (files or unified diff), run eval, return feedback + shouldHalt
 *  - trm.getState            : snapshot of scores/history
 *  - trm.shouldHalt          : return current halting decision
 *  - trm.endSession          : cleanup
 *
 * Scoring:
 *  score in [0..1] from weighted signals:
 *   - tests: passed/total (required if provided)
 *   - build: success/fail
 *   - lint: success/fail (optional)
 *   - perf: normalized vs best-so-far (optional)
 *
 * Halting:
 *  shouldHalt = true if:
 *    - all tests pass AND score >= passThreshold, OR
 *    - no improvement for K consecutive steps, OR
 *    - steps >= maxSteps
 *
 * Safe execution:
 *  - Commands executed in provided repoPath with timeouts.
 *  - No network access, only local cmds.
 */

// ------------- MCP server ----------------

const transport = new StdioServerTransport();
const server = new Server(
  {
    name: "mcp-trm-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
      resources: {},
    },
  }
);

// Register tools list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  return await handleToolCall(req);
});

await server.connect(transport);
console.error(pc.dim(`[mcp-trm-server] ready on stdio`));
