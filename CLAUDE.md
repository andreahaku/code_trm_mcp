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

## MCP Tools (15 total - Ultra-Optimized)

**Note**: Tool names are shortened for token efficiency. Parameter names also shortened (sid vs sessionId, repo vs repoPath, etc). See `docs/MIGRATION_COMPLETE.md` for full mapping.

**Core (6)**:
1. `trm.start` - Initialize session (was startSession)
2. `trm.submit` - Apply changes and evaluate (was submitCandidate)
3. `trm.read` - Read files with metadata (was getFileContent)
4. `trm.state` - Get session state (was getState)
5. `trm.halt` - Check halting decision (was shouldHalt)
6. `trm.end` - Cleanup (was endSession)

**Enhancement (6)**:
7. `trm.validate` - Dry-run validation (was validateCandidate)
8. `trm.suggest` - AI suggestions (was getSuggestions)
9. `trm.save` - Save state (was saveCheckpoint)
10. `trm.restore` - Restore state (was restoreCheckpoint)
11. `trm.list` - List checkpoints (was listCheckpoints)
12. `trm.reset` - Git reset (was resetToBaseline)

**Advanced (3)**:
13. `trm.undo` - Quick undo (was undoLastCandidate)
14. `trm.lines` - Read line ranges (was getFileLines)
15. `trm.fix` - AI fix generation (was suggestFix)

**Token savings**: 660 tokens (28%) via shortened names + compressed descriptions

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

## Token Optimization

**Active**: Ultra-optimized schema (28% reduction, 660 tokens saved)
- Shortened tool names (`trm.submit` vs `trm.submitCandidate`)
- Shortened property names (`sid` vs `sessionId`)
- Translation layer: `param-translator.ts` maps short→original for handlers

See `docs/MIGRATION_COMPLETE.md` for details, `docs/ULTRA_OPTIMIZATION.md` for full guide.

## Documentation

- `TRM_IMPROVEMENTS.md`: Phase 1-3 enhancements with examples
- `REFACTORING.md`: Server and handler refactoring details
- `README.md`: User-facing documentation
- `docs/MIGRATION_COMPLETE.md`: Ultra optimization details
- `docs/ULTRA_OPTIMIZATION.md`: Complete optimization guide
