# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build, Lint, and Test Commands

```bash
# Build the project (compile TypeScript)
npm run build

# Start the MCP server
npm start

# Development mode (watch for changes)
npm run dev
```

**Note**: This project does not have lint or test commands configured. When adding tests, use `--silent` and `--reporter=json` flags for compatibility with TRM evaluation.

## Architecture Overview

This is an **MCP (Model Context Protocol) server** implementing TRM-inspired (Test-time Recursive Memory) recursive code refinement for LLM development tools.

### Core Concept

- **LLM Client** (Claude Code/Cursor/Codex): Acts as the **optimizer** proposing code changes
- **MCP TRM Server**: Acts as the **critic/evaluator** with stateful session tracking
- **Feedback Loop**: Build/test/lint/bench → weighted score → EMA tracking → halting policy

### Key Directories

```
src/
├── server.ts                    # MCP server entry point (ultra-optimized)
├── types.ts                     # Core type definitions
├── constants.ts                 # Configuration constants
├── tools/
│   ├── schemas.ultra.ts         # Ultra-optimized tool schemas (~30% token reduction)
│   ├── param-translator.ts      # Short→full parameter name translation
│   └── handlers/                # Tool implementation handlers
│       ├── index.ultra.ts       # Handler registry (ultra-optimized)
│       ├── session.ts           # Session lifecycle (start/end)
│       ├── candidate.ts         # Candidate submission/validation/undo
│       ├── file.ts              # File operations (read/lines)
│       ├── state.ts             # State queries (state/halt/suggestions)
│       ├── checkpoint.ts        # Checkpoint management
│       ├── baseline.ts          # Baseline reset
│       ├── fix.ts               # AI-powered fix suggestions
│       └── lib/                 # Shared handler utilities
│           ├── evaluation.ts    # Evaluation pipeline
│           ├── feedback.ts      # Feedback generation
│           ├── file-management.ts # File snapshot/restore
│           ├── response-utils.ts  # Response formatting
│           └── runtime-validation.ts # Parameter validation
├── patcher/
│   ├── candidate.ts             # Candidate application logic
│   ├── custom-patcher.ts        # Fuzzy diff/patch matching
│   └── edit-operations.ts       # Semantic edit operations
├── analyzer/
│   ├── code-analyzer.ts         # Code quality analysis
│   └── suggestions.ts           # AI suggestion generation
├── state/
│   ├── baseline.ts              # Git baseline management
│   └── checkpoints.ts           # Checkpoint utilities
├── shared/
│   └── sessions.ts              # Global session storage (Map<SessionId, SessionState>)
└── utils/
    ├── command.ts               # Shell command execution
    ├── scoring.ts               # Score calculation (weighted average)
    ├── parser.ts                # Test output parsing (Jest/Vitest)
    ├── ts-error-parser.ts       # TypeScript error extraction
    ├── error-context.ts         # Error correlation
    ├── fix-generator.ts         # Auto-fix generation
    ├── mode-suggestion.ts       # Submission mode suggestions
    └── validation.ts            # Path safety validation
```

### Modular Handler Architecture

**Key refactoring (74a2f30)**: Split monolithic `server.ts` into modular handlers.

**Handler Pattern**:
- Each handler in `tools/handlers/` is a pure function: `(args) => Promise<ToolResponse>`
- Handlers access global `sessions` Map from `shared/sessions.ts`
- Handler utilities in `tools/handlers/lib/` provide shared evaluation/feedback/file logic
- `index.ultra.ts` routes tool calls via `handleToolCall(req)` with parameter translation

**Why this matters**:
- Handlers are independently testable
- Complexity reduced from ~900 lines to <100 lines per handler
- Easy to add new tools without touching core server logic

### Session State Management

**Global Storage**: `sessions` Map in `shared/sessions.ts`
- Key: `SessionId` (string)
- Value: `SessionState` object

**SessionState Structure** (types.ts:174-199):
```typescript
{
  id: SessionId;
  cfg: SessionConfig;              // Commands, weights, halt policy
  step: number;                    // Current iteration
  bestScore: number;               // Best score achieved
  emaScore: number;                // Exponential moving average
  emaAlpha: number;                // EMA smoothing factor
  noImproveStreak: number;         // Consecutive steps without improvement
  history: EvalResult[];           // Past evaluation results
  zNotes?: string;                 // Latent reasoning notes
  bestPerf?: number;               // Best performance value
  mode: SessionMode;               // "cumulative" | "snapshot"
  checkpoints: Map<string, Checkpoint>;
  baselineCommit?: string;         // Git commit for reset
  modifiedFiles: Set<string>;      // Track changes for error correlation
  fileSnapshots: Map<string, string>; // File content cache
  commandStatus: {...};            // Command availability
  iterationContexts: IterationContext[]; // For error correlation
  candidateSnapshots: CandidateSnapshot[]; // For undo functionality
}
```

### Evaluation Pipeline

Located in `tools/handlers/lib/evaluation.ts`.

**Flow** (on `trm.submitCandidate`):
1. **Apply candidate** via `patcher/candidate.ts` (validate → apply)
2. **Run commands** sequentially: build → test → lint → bench
3. **Parse outputs** (extract pass/fail, test counts, perf metrics)
4. **Compute score** using weighted average (scoring.ts):
   ```
   score = (w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumWeights
   ```
5. **Update EMA**: `emaScore = alpha * score + (1 - alpha) * prevEmaScore`
6. **Check improvement streak**: Reset or increment `noImproveStreak`
7. **Generate feedback** (feedback.ts): TypeScript errors, test failures, mode suggestions
8. **Check halting policy**: Pass threshold, patience exhausted, max steps
9. **Return EvalResult**: `{ step, score, emaScore, feedback, shouldHalt, ... }`

### Candidate Submission Modes

**Recommended** (new, semantic):
- `create`: New files only (validates non-existence)
- `modify`: Semantic edit operations (replace, insertBefore, insertAfter, replaceLine, deleteRange, etc.)

**Legacy** (still supported):
- `diff`: Per-file unified diffs with custom fuzzy patcher
- `patch`: Single unified diff for multiple files
- `files`: Complete file contents (inefficient for large files)

**Validation**: Pre-apply validation checks:
- Line numbers within file bounds
- No duplicate function/class declarations near insertion points
- Path safety (prevent traversal)
- File size limits (10MB per file, 50 files max)

See `patcher/candidate.ts:28-120` for validation logic.

### Error Correlation

**Feature**: Track which iteration introduced each error.

**Implementation** (utils/error-context.ts):
- Store `iterationContexts` per session (step, filesModified, mode, success)
- On TypeScript errors: correlate error locations with past iterations
- Feedback includes: "Error at file.ts:50 introduced in step 3 (modified server.ts)"

**Benefit**: Helps LLM identify which change caused the error.

### Token Optimization Strategy

**Ultra-optimized schemas** (schemas.ultra.ts):
- Tool names shortened: `trm.submitCandidate` → `trm.submit`
- Property names shortened: `sessionId` → `sid`, `repoPath` → `repo`
- Descriptions compressed
- **Result**: ~30% token reduction vs original schemas

**Parameter Translation** (param-translator.ts):
- Maps short names back to full internal names
- Preserves backward compatibility
- Transparent to handlers

**Why**: MCP protocol overhead is ~7,200 tokens. Every token saved = more code context.

## TypeScript Configuration

- **Target**: ES2022
- **Module**: NodeNext (ESM)
- **Strict mode**: Enabled
- **Output**: `dist/` directory
- **Source maps**: Enabled for debugging

## Development Workflow

### Adding a New Tool

1. **Define schema** in `src/tools/schemas.ultra.ts`
   - Use short property names for token efficiency
   - Add to `tools` array
2. **Create handler** in `src/tools/handlers/`
   - Pure function: `(args) => Promise<ToolResponse>`
   - Access `sessions` from `shared/sessions.ts`
   - Use utilities from `lib/` for common tasks
3. **Register in router** at `src/tools/handlers/index.ultra.ts`
   - Add case to switch statement
   - Tool name must match schema
4. **Add translation mapping** in `src/tools/param-translator.ts` (if using short property names)
5. **Update types** in `src/types.ts` if needed

### Modifying Evaluation Logic

- **Score calculation**: `src/utils/scoring.ts`
- **Command execution**: `src/utils/command.ts`
- **Test parsing**: `src/utils/parser.ts`
- **Feedback generation**: `src/tools/handlers/lib/feedback.ts`

### Working with Candidate Modes

- **Diff/patch application**: `src/patcher/custom-patcher.ts` (fuzzy matching logic)
- **Edit operations**: `src/patcher/edit-operations.ts` (semantic edits)
- **Validation**: `src/patcher/candidate.ts:28-120` (pre-apply checks)

## Important Constants

Located in `src/constants.ts`:
```typescript
MAX_FILE_SIZE = 10MB      // Per-file size limit
MAX_CANDIDATE_FILES = 50  // Max files per submission
```

## Recent Refactoring History

- **9a42031**: Optimized MCP tool schemas (4% token reduction, 384 tokens saved)
- **c46bb8a**: Extracted handler utilities to reduce complexity
- **74a2f30**: Split monolithic server.ts into modular handler architecture
- **fb56867**: Removed internal phase terminology from docs

## Testing Strategy

When adding tests:
- Use Jest or Vitest with `--silent` and `--reporter=json` flags
- JSON output enables accurate test score calculation
- Example test command: `npm test --silent -- --reporter=json`

## Security Notes

- Path validation: All file paths validated via `validateSafePath()` to prevent traversal
- Command timeouts: Configurable timeout (default 120s) prevents runaway processes
- File size limits: Prevents memory exhaustion from large submissions
