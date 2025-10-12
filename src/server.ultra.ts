#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pc from "picocolors";

// Import ultra-optimized tool schemas and handler registry
import { tools } from "./tools/schemas.ultra.js";
import { handleToolCall } from "./tools/handlers/index.ultra.js";

/**
 * Ultra-optimized TRM MCP server with shortened tool/property names.
 * Uses param-translator to map short names to internal format.
 *
 * ~30% token reduction vs original schema through:
 * - Shortened tool names (trm.submitCandidate → trm.submit)
 * - Shortened property names (sessionId → sid, repoPath → repo)
 * - Compressed descriptions
 */

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
console.error(pc.dim(`[mcp-trm-server] ready on stdio (ultra-optimized)`));
