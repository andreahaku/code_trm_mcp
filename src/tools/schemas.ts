import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * All TRM MCP tool schemas.
 * Defines the 15 tools exposed by the server across three phases:
 * - Phase 1: Core tools (startSession, submitCandidate, getFileContent, getState, shouldHalt, endSession)
 * - Phase 2: Enhancement tools (validateCandidate, getSuggestions, checkpoints, baseline)
 * - Phase 3: Advanced tools (undoLastCandidate, getFileLines, suggestFix)
 */

export const tools: Tool[] = [
  {
    name: "trm.startSession",
    description: "Initialize a TRM session on a local repository with evaluation commands and halting policy.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Absolute path to the project repository" },
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
        zNotes: { type: "string", description: "Optional initial reasoning notes/hints" }
      },
      required: ["repoPath", "halt"]
    }
  },
  {
    name: "trm.submitCandidate",
    description: "Apply candidate changes and run evaluation. **STRONGLY PREFERRED: Use 'diff' mode (per-file diffs) or 'patch' mode (unified diff) for efficiency.** Use trm.getFileContent first to read current file state, then generate diffs. Only use 'files' mode for new files or complete rewrites (discouraged for large files).",
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
                      path: { type: "string", description: "Relative path to file" },
                      diff: { type: "string", description: "Unified diff format (git diff style)" }
                    },
                    required: ["path", "diff"]
                  },
                  description: "Array of per-file diffs in unified format"
                }
              },
              required: ["mode", "changes"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "patch" },
                patch: { type: "string", description: "Complete unified diff (git diff output)" }
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
                  },
                  description: "Complete file contents (use only for new files)"
                }
              },
              required: ["mode", "files"]
            }
          ]
        },
        rationale: { type: "string", description: "LLM notes: why these changes, expected effects, hypotheses" }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getFileContent",
    description: "Read current content of files from the repository. Use this before generating diffs to ensure accurate changes. Returns file contents indexed by path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Relative paths to read from repository (e.g., ['src/server.ts', 'package.json'])"
        }
      },
      required: ["sessionId", "paths"]
    }
  },
  {
    name: "trm.getState",
    description: "Return current TRM state (scores, EMA, history summary).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.shouldHalt",
    description: "Return halting decision based on latest evaluation.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.endSession",
    description: "End and remove a TRM session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.validateCandidate",
    description: "Validate candidate changes without applying them (dry-run). Returns validation results with errors, warnings, and preview of changes.",
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
    description: "Get AI-powered suggestions for code improvements based on evaluation results and code analysis. Returns top suggestions prioritized by criticality.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.saveCheckpoint",
    description: "Save current session state as a checkpoint for later restoration.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        description: { type: "string", description: "Optional description for the checkpoint" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.restoreCheckpoint",
    description: "Restore session state from a previously saved checkpoint.",
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
    description: "List all saved checkpoints for a session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.resetToBaseline",
    description: "Reset session to initial baseline state (using git reset if in a git repository).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.undoLastCandidate",
    description: "Undo the last candidate submission and restore previous file state. Rolls back to the state before the last submitCandidate call.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.getFileLines",
    description: "Read a specific line range from a file. Returns lines with line numbers for easy reference. Useful for reading large files incrementally without loading entire content.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        file: { type: "string", description: "Relative path to file" },
        startLine: { type: "number", description: "Starting line number (1-based, inclusive)" },
        endLine: { type: "number", description: "Ending line number (1-based, inclusive)" }
      },
      required: ["sessionId", "file", "startLine", "endLine"]
    }
  },
  {
    name: "trm.suggestFix",
    description: "Generate actionable fix candidates based on error analysis from the last evaluation. Returns ready-to-apply candidates that can be directly submitted via trm.submitCandidate. Analyzes TypeScript errors, test failures, and lint issues to provide concrete fix suggestions.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  }
];
