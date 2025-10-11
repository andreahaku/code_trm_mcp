# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **MCP (Model Context Protocol) server** that implements a TRM-inspired (Test-time Recursive Memory) recursive code refinement system. It acts as a stateful evaluator for LLM-driven code improvements, running build/test/lint/benchmark commands and providing scored feedback to guide iterative refinement.

**Key concept**: The LLM acts as the **optimizer** proposing changes, while this server acts as the **critic** with objective evaluation signals.

## Build and Development Commands

```bash
# Build the TypeScript project
npm run build

# Watch mode for development
npm run dev

# Run the compiled server (after building)
npm start
# or
node dist/server.js
```

**Important**: The project uses ES modules (`"type": "module"` in package.json) with NodeNext module resolution. All imports must use `.js` extensions even for `.ts` files.

## Architecture and Code Structure

### Core File: `src/server.ts` (~2,255 lines)

The entire MCP server is implemented in a single file with these major sections:

#### 1. **Type Definitions (lines 1-285)**
- Core types: `SessionState`, `EvalResult`, `SessionConfig`
- **NEW**: Enhanced API types for improved features:
  - `SessionMode`: `"cumulative"` | `"snapshot"`
  - `Checkpoint`: State restoration points
  - `CreateSubmission` / `ModifySubmission`: Simplified submission modes
  - `EditOperation`: Semantic edit operations (replace, insertBefore, etc.)
  - `Suggestion`: AI-powered improvement suggestions
  - `EnhancedError`: Detailed error information with context
  - `ValidationResult`: Dry-run validation results

#### 2. **Helper Functions (lines 286-599)**
- `validateSafePath()`: Path traversal protection
- `parseCommand()`: Shell command parsing with quote handling
- `runCmd()`: Command execution with timeout and error handling
- `parseTestOutput()`: Extracts test results from Jest/Vitest/Mocha output
- `scoreFromSignals()`: Computes weighted score from build/test/lint/perf
- `shouldHalt()`: Implements ACT-like halting policy
- `diffHints()`: Extracts actionable error messages from command output

#### 3. **Custom Patcher System (lines 600-1000)** ⭐ NEW
Replaces fragile `git apply` with robust fuzzy-matching patcher:

- **`parseUnifiedDiff()`**: Parses unified diff format into structured hunks
- **`applyHunk()`**: Applies hunks with **fuzzy matching** (80% threshold)
  - Tries exact match first
  - Falls back to fuzzy search within ±2 lines
  - Returns detailed error with match score if failed
- **`customPatch()`**: Orchestrates patch application with error collection
- **`applyEditOperations()`**: Applies semantic operations (replace text, insert/delete lines, etc.)

**Why this matters**: Git apply frequently failed with "corrupt patch" errors. Custom patcher handles whitespace differences and provides actionable error messages.

#### 4. **Code Analysis System (lines 1067-1311)** ⭐ NEW
AI-powered code quality analyzer:

- **`analyzeCodeFile()`**: Static analysis detecting:
  - `any` type usage
  - Magic numbers
  - Missing JSDoc
  - Long functions (>100 lines)
  - Missing error handling in async functions
- **`generateSuggestions()`**: Creates prioritized suggestions combining:
  - Evaluation results (build/test/lint failures)
  - Code quality issues from static analysis
  - Performance regressions (>10% slower)
  - Returns top 5 suggestions sorted by priority (critical → high → medium → low)

#### 5. **Improved Candidate Application (lines 1313-1577)** ⭐ NEW
- **`applyImprovedCandidate()`**: Handles new create/modify modes
- **`validateCandidate()`**: Dry-run validation with preview of changes

#### 6. **State Management (lines 1579-1671)** ⭐ NEW
- **`saveCheckpoint()`**: Captures session state for restoration
- **`restoreCheckpoint()`**: Restores from checkpoint
- **`resetToBaseline()`**: Resets to initial git commit
- **`autoCheckpoint()`**: Auto-saves after successful iterations

#### 7. **MCP Server Setup (lines 1672-2255)**
- Tool definitions with JSON schemas
- Request handlers for all 13 MCP tools
- Session management (`Map<SessionId, SessionState>`)

### MCP Tools Available

**Original 6 tools:**
1. `trm.startSession` - Initialize with repo path, commands, weights, halt policy
2. `trm.submitCandidate` - Apply changes, run evaluation, get feedback
3. `trm.getFileContent` - Read current file state (for generating diffs)
4. `trm.getState` - Get current session state snapshot
5. `trm.shouldHalt` - Check halting decision
6. `trm.endSession` - Clean up session

**New 7 tools** (from recent improvements):
7. `trm.validateCandidate` - Dry-run validation without applying
8. `trm.getSuggestions` - Get AI-powered improvement suggestions
9. `trm.saveCheckpoint` - Save current state
10. `trm.restoreCheckpoint` - Restore from checkpoint
11. `trm.listCheckpoints` - List all checkpoints
12. `trm.resetToBaseline` - Reset to initial state

### Submission Modes

**Legacy modes** (still supported):
- `diff`: Per-file unified diffs (now uses custom patcher instead of git apply)
- `patch`: Single unified diff for multiple files (custom patcher)
- `files`: Complete file contents (for new files or rewrites)

**New modes** (recommended):
- `create`: For new files only (validates file doesn't exist)
- `modify`: For existing files with semantic operations:
  ```typescript
  {
    mode: "modify",
    changes: [{
      file: "src/server.ts",
      edits: [
        { type: "replace", oldText: "err: any", newText: "err: unknown", all: true },
        { type: "insertAfter", line: 150, content: "const NEW_CONSTANT = 42;" },
        { type: "replaceLine", line: 200, content: "// Updated comment" }
      ]
    }]
  }
  ```

### Session State Management

Sessions now support two modes:

- **`cumulative`** (default): Each iteration builds on the previous state
- **`snapshot`**: Can reset to checkpoints or baseline between iterations

Set via `mode` parameter in `trm.startSession`:
```typescript
{
  mode: "cumulative",  // or "snapshot"
  autoCommit: true,    // Auto-commit successful iterations
  autoCheckpoint: true // Auto-save checkpoints
}
```

## Key Design Patterns

### 1. **Stateful Sessions**
Each session maintains:
- Current step number and scores (current, EMA, best)
- Improvement streak tracking
- Complete evaluation history
- Checkpoint system (new)
- Baseline git commit reference (new)

### 2. **Weighted Scoring System**
```
score = (w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumWeights

where each signal ∈ [0, 1]
```

### 3. **Fuzzy Patch Application**
Unlike git apply, the custom patcher:
- Searches ±2 lines for best match
- Requires 80% line match threshold
- Provides detailed error context (expected vs got, match score)
- Handles whitespace variations gracefully

### 4. **Error Handling Philosophy**
All errors use `EnhancedError` type with:
- `error`: Human-readable message
- `code`: Machine-readable error code
- `details.failedAt`: Location of failure
- `details.reason`: Root cause
- `details.expected` / `details.got`: Comparison context
- `details.suggestion`: Actionable fix recommendation
- `details.context`: Additional debugging info

## Testing This Server

Since this is an MCP server, it's meant to be called by MCP clients (Claude Code, Cursor, etc.). For manual testing:

1. Build: `npm run build`
2. Connect via MCP client configuration
3. Test on a sample repository with known build/test/lint commands

**Common test scenario:**
```typescript
// 1. Start session pointing to this repo
await trm.startSession({
  repoPath: "/path/to/code_trm_mcp",
  buildCmd: "npm run build",
  halt: { maxSteps: 5, passThreshold: 0.95, patienceNoImprove: 2 }
});

// 2. Validate a change first (dry-run)
await trm.validateCandidate({
  sessionId: "...",
  candidate: { mode: "modify", changes: [...] }
});

// 3. Submit if validation passes
await trm.submitCandidate({
  sessionId: "...",
  candidate: { mode: "modify", changes: [...] },
  rationale: "Fixing type error in parseCommand function"
});

// 4. Get suggestions for next iteration
await trm.getSuggestions({ sessionId: "..." });
```

## Important Constants

Defined in `src/server.ts`:
- `MAX_FILE_SIZE`: 10MB per file
- `MAX_CANDIDATE_FILES`: 100 files per submission
- `MAX_RATIONALE_LENGTH`: 4000 characters
- `SCORE_IMPROVEMENT_EPSILON`: 1e-6 (minimum improvement to reset streak)
- `MAX_HINT_LINES`: 12 error hint lines in feedback
- `MAX_FEEDBACK_ITEMS`: 16 total feedback items
- `MAX_FILE_READ_PATHS`: 50 files in single getFileContent request

## Security Notes

- **Path traversal protection**: `validateSafePath()` ensures all file operations stay within repository bounds
- **Command injection protection**: `parseCommand()` respects quotes, `execa` uses array args (no shell by default)
- **Size limits**: Enforced on file sizes, candidate file counts, and rationale length
- **Timeout enforcement**: All commands have configurable timeouts (default 120s)

## Recent Major Changes

**Latest commit (6ebc1b4)** added comprehensive improvements:
- Custom patcher system replacing git apply
- State management with checkpoints
- Simplified create/modify submission modes
- Code analyzer with AI-powered suggestions
- Validation/dry-run tool
- Enhanced error messages with detailed context
- 13 new TypeScript types
- 6 new MCP tools

These changes address all pain points from practical usage: git apply failures, unclear state management, and lack of actionable feedback.

## Philosophy: TRM → MCP Adaptation

This server adapts the TRM (Test-time Recursive Memory) research into a practical MCP tool:

- **y (solution state)**: Repository files after each patch
- **z (latent reasoning)**: `rationale` and `zNotes` maintain context without verbose Chain-of-Thought
- **Deep supervision**: Objective signals (build/test/lint/bench) guide convergence
- **ACT halting**: Clear stopping rules (tests pass + threshold, plateau, max steps)
- **Small patches**: Maximize information per step (TRM principle)
- **No training needed**: Pure test-time refinement using existing dev tools
