import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Optimized TRM MCP tool schemas (token-reduced).
 * 15 tools: Core (6) + Enhancement (6) + Advanced (3)
 */

export const tools: Tool[] = [
  {
    name: "trm.startSession",
    description: "Init TRM session with eval commands & halt policy.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        buildCmd: { type: "string" },
        testCmd: { type: "string" },
        lintCmd: { type: "string" },
        benchCmd: { type: "string" },
        timeoutSec: { type: "number", default: 120 },
        weights: {
          type: "object",
          properties: {
            build: { type: "number", default: 0.3 },
            test: { type: "number", default: 0.5 },
            lint: { type: "number", default: 0.1 },
            perf: { type: "number", default: 0.1 }
          },
          required: []
        },
        halt: {
          type: "object",
          properties: {
            maxSteps: { type: "number", default: 12 },
            passThreshold: { type: "number", default: 0.95 },
            patienceNoImprove: { type: "number", default: 3 },
            minSteps: { type: "number", default: 1 }
          },
          required: ["maxSteps", "passThreshold", "patienceNoImprove"]
        },
        emaAlpha: { type: "number", default: 0.9 },
        zNotes: { type: "string" }
      },
      required: ["repoPath", "halt"]
    }
  },
  {
    name: "trm.submitCandidate",
    description: "Apply changes & eval. Prefer diff/patch modes; use getFileContent first.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidate: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "diff" },
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      diff: { type: "string" }
                    },
                    required: ["path", "diff"]
                  }
                }
              },
              required: ["mode", "changes"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "patch" },
                patch: { type: "string" }
              },
              required: ["mode", "patch"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "files" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              required: ["mode", "files"]
            }
          ]
        },
        rationale: { type: "string" }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getFileContent",
    description: "Read file contents from repo.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        paths: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["sessionId", "paths"]
    }
  },
  {
    name: "trm.getState",
    description: "Get session state (scores, EMA, history).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.shouldHalt",
    description: "Get halting decision from latest eval.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.endSession",
    description: "End & cleanup session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.validateCandidate",
    description: "Validate changes (dry-run).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidate: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "create" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              required: ["mode", "files"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "modify" },
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      file: { type: "string" },
                      edits: { type: "array" }
                    },
                    required: ["file", "edits"]
                  }
                }
              },
              required: ["mode", "changes"]
            }
          ]
        }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getSuggestions",
    description: "Get AI improvement suggestions.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.saveCheckpoint",
    description: "Save checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        description: { type: "string" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.restoreCheckpoint",
    description: "Restore checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        checkpointId: { type: "string" }
      },
      required: ["sessionId", "checkpointId"]
    }
  },
  {
    name: "trm.listCheckpoints",
    description: "List checkpoints.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.resetToBaseline",
    description: "Reset to baseline (git reset).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.undoLastCandidate",
    description: "Undo last candidate.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.getFileLines",
    description: "Read file line range.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        file: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" }
      },
      required: ["sessionId", "file", "startLine", "endLine"]
    }
  },
  {
    name: "trm.suggestFix",
    description: "Generate fix candidates from eval errors.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  }
];
