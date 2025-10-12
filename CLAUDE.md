# CLAUDE.md

## Project Overview

**MCP server** implementing TRM (Test-time Recursive Memory) for LLM-driven code refinement. The LLM proposes changes, this server evaluates them with build/test/lint/bench commands and provides scored feedback.

## Build Commands

```bash
npm run build      # Build TypeScript
npm run dev        # Watch mode
npm start          # Run server
```

**Important**: ES modules with NodeNext resolution. All imports must use `.js` extensions (even for `.ts` files).

## Architecture

```
src/
├── server.ts                 # MCP server orchestration (15 tools)
├── types.ts                  # TypeScript types
├── constants.ts              # Configuration constants
├── shared/
│   └── sessions.ts           # Shared session state map
├── tools/handlers/           # Tool implementation handlers
│   ├── index.ts              # Handler registry and routing
│   ├── session.ts            # Session lifecycle (start/end)
│   ├── candidate.ts          # Submit/validate/undo candidates
│   ├── file.ts               # File operations
│   ├── state.ts              # State queries
│   ├── checkpoint.ts         # Checkpoint management
│   ├── baseline.ts           # Git baseline reset
│   ├── fix.ts                # Fix suggestions
│   └── lib/                  # Handler utilities
│       ├── evaluation.ts     # Run build/test/lint/bench
│       ├── feedback.ts       # Generate feedback with error correlation
│       ├── file-management.ts # File snapshots and tracking
│       ├── runtime-validation.ts # Type-safe argument validation
│       └── response-utils.ts # Standardized responses
├── utils/                    # Core utilities
│   ├── validation.ts         # Path validation, type guards
│   ├── command.ts            # Command execution
│   ├── scoring.ts            # TRM scoring and halting
│   ├── parser.ts             # Test output and diff parsing
│   ├── ts-error-parser.ts    # TypeScript error parsing
│   ├── mode-suggestion.ts    # Mode recommendations
│   ├── error-context.ts      # Error correlation
│   └── fix-generator.ts      # AI fix generation
├── patcher/                  # Patch application
│   ├── custom-patcher.ts     # Fuzzy-matching patcher
│   ├── edit-operations.ts    # Semantic edit operations
│   └── candidate.ts          # Apply/validate candidates
├── analyzer/                 # Code quality analysis
│   ├── code-analyzer.ts      # Static analysis
│   └── suggestions.ts        # AI suggestions
└── state/                    # Session management
    ├── checkpoints.ts        # Save/restore
    └── baseline.ts           # Git reset
```

**No circular dependencies** - Clean flow: server → handlers → utils → types/constants

## Handler Architecture

**Pattern**: Handler registry (`index.ts`) routes requests to domain-specific handlers. Each handler uses utility modules from `lib/` for common operations.

**Handler utilities** (`src/tools/handlers/lib/`):
- `evaluation.ts`: Run evaluation commands, compute scores
- `feedback.ts`: Generate feedback with TypeScript error parsing and suggestions
- `file-management.ts`: Extract files, create snapshots for undo
- `runtime-validation.ts`: Type-safe argument validation
- `response-utils.ts`: Standardized response formats (success/error)

**Key refactoring**: candidate.ts reduced from 401 lines (complexity 73) to 247 lines (complexity 30) by extracting utilities.

## MCP Tools (15 total)

**Core (6)**:
1. `trm.startSession` - Initialize session
2. `trm.submitCandidate` - Apply changes and evaluate
3. `trm.getFileContent` - Read files with metadata
4. `trm.getState` - Get session state
5. `trm.shouldHalt` - Check halting decision
6. `trm.endSession` - Cleanup

**Enhancement (6)**:
7. `trm.validateCandidate` - Dry-run validation
8. `trm.getSuggestions` - AI suggestions
9. `trm.saveCheckpoint` - Save state
10. `trm.restoreCheckpoint` - Restore state
11. `trm.listCheckpoints` - List checkpoints
12. `trm.resetToBaseline` - Git reset

**Advanced (3)**:
13. `trm.undoLastCandidate` - Quick undo
14. `trm.getFileLines` - Read line ranges
15. `trm.suggestFix` - AI fix generation

## Submission Modes

**Recommended (new)**:
- `create`: New files only
- `modify`: Semantic edit operations (replace, insertBefore, insertAfter, replaceLine, etc.)

**Legacy (still supported)**:
- `diff`: Per-file unified diffs
- `patch`: Single unified diff
- `files`: Complete file contents

**Example modify mode**:
```typescript
{
  mode: "modify",
  changes: [{
    file: "src/server.ts",
    edits: [
      { type: "replace", oldText: "err: any", newText: "err: unknown", all: true },
      { type: "insertAfter", line: 150, content: "const NEW_CONSTANT = 42;" }
    ]
  }]
}
```

## Key Patterns

**Weighted scoring**:
```
score = (w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumWeights
where each signal ∈ [0, 1]
```

**Fuzzy patcher**: Unlike git apply, handles whitespace variations, searches ±2 lines for matches, requires 80% line match threshold.

**Error handling**: All errors include actionable context (expected vs got, suggestions, location).

## Important Constants

`src/constants.ts`:
- `MAX_FILE_SIZE`: 10MB
- `MAX_CANDIDATE_FILES`: 100
- `MAX_RATIONALE_LENGTH`: 4000 chars
- `SCORE_IMPROVEMENT_EPSILON`: 1e-6
- `MAX_HINT_LINES`: 12
- `MAX_FEEDBACK_ITEMS`: 16
- `MAX_FILE_READ_PATHS`: 50

## Security

- Path traversal protection: `validateSafePath()`
- Command injection protection: `execa` with array args
- Size limits enforced on all inputs
- Configurable timeouts (default 120s)

## TRM Principles

- **y (state)**: Repository files after each patch
- **z (reasoning)**: `rationale` and `zNotes` maintain context
- **Deep supervision**: Objective signals (build/test/lint/bench)
- **ACT halting**: Stop when tests pass + threshold, plateau, or max steps
- **Small patches**: Maximize information per step
- **No training**: Pure test-time refinement

## Documentation

- `TRM_IMPROVEMENTS.md`: Phase 1-3 enhancements with examples
- `REFACTORING.md`: Server and handler refactoring details
- `README.md`: User-facing documentation
