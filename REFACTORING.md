# Server.ts Modular Refactoring

## Overview

The original `server.ts` file (2494 lines) has been split into logical, maintainable modules for better organization, testability, and code quality.

## Completed Modules ✅

### Core Type Definitions
- **`src/types.ts`** - All TypeScript type definitions
  - Session types (SessionState, SessionConfig, EvalResult)
  - Request/Response types (StartSessionArgs, SubmitCandidateArgs, etc.)
  - Enhanced API types (CreateSubmission, ModifySubmission, EditOperation)
  - Code quality types (CodeIssue, Suggestion, EnhancedError)

### Constants
- **`src/constants.ts`** - All configuration constants
  - File size limits, timeouts, thresholds
  - Response limits and pagination settings

### Utilities (`src/utils/`)
- **`validation.ts`** - Validation logic
  - `validateSafePath()` - Path traversal protection
  - `validateStartSessionArgs()` - Argument validation
  - `isExecaError()` - Type guards
  - `clamp01()` - Math utilities

- **`command.ts`** - Command execution
  - `parseCommand()` - Shell command parsing with quote handling
  - `runCmd()` - Command execution with timeout

- **`scoring.ts`** - TRM scoring and halting logic
  - `scoreFromSignals()` - Weighted score computation
  - `shouldHalt()` - ACT-like halting policy
  - `diffHints()` - Error hint extraction

- **`parser.ts`** - Output parsing
  - `parseTestOutput()` - Jest/Vitest/Mocha output parsing
  - `parseUnifiedDiff()` - Unified diff parsing

## Remaining Modules (To Be Created)

### Patcher Module (`src/patcher/`)
- **`custom-patcher.ts`** - Custom patch application with fuzzy matching
  - `applyHunk()` - Apply single hunk with fuzzy matching
  - `customPatch()` - Main patcher function

- **`edit-operations.ts`** - Semantic edit operations
  - `applyEditOperations()` - Apply replace/insert/delete operations

- **`candidate.ts`** - Candidate application
  - `applyCandidate()` - Main candidate application logic
  - `applyImprovedCandidate()` - Enhanced submission modes
  - `validateCandidate()` - Dry-run validation

### Analyzer Module (`src/analyzer/`)
- **`code-analyzer.ts`** - Static code analysis
  - `analyzeCodeFile()` - Detect code quality issues
  - `analyzeCodeFileEnhanced()` - Enhanced analysis with complexity/nesting
  - `calculateCyclomaticComplexity()` - Complexity metrics
  - `detectMaxNesting()` - Nesting depth detection

- **`suggestions.ts`** - AI-powered suggestions
  - `generateSuggestions()` - Generate prioritized improvement suggestions

### State Management (`src/state/`)
- **`checkpoints.ts`** - Checkpoint management
  - `saveCheckpoint()` - Save session state
  - `restoreCheckpoint()` - Restore from checkpoint
  - `autoCheckpoint()` - Auto-checkpoint after iterations

- **`baseline.ts`** - Baseline management
  - `resetToBaseline()` - Reset to initial git commit

### Main Server
- **`src/server.ts`** (refactored) - MCP server setup and handlers
  - Import all modules
  - Tool definitions (13 MCP tools)
  - Request handlers
  - Server initialization

## Benefits of Modular Structure

### 1. **Improved Maintainability**
- Each module has a single, clear responsibility
- Easier to locate and fix bugs
- Simpler to understand code flow

### 2. **Better Testability**
- Each module can be tested independently
- Easier to mock dependencies
- Improved test coverage potential

### 3. **Reduced Complexity**
- Smaller files (< 200 lines each vs 2494 lines)
- Lower cyclomatic complexity per module
- Reduced nesting depth

### 4. **Enhanced Reusability**
- Utility functions can be reused across modules
- Type definitions centralized
- Constants easily accessible

### 5. **Easier Collaboration**
- Multiple developers can work on different modules
- Clearer git history with modular commits
- Reduced merge conflicts

## Module Dependency Graph

```
server.ts
├── types.ts
├── constants.ts
├── utils/
│   ├── validation.ts
│   ├── command.ts (uses validation)
│   ├── scoring.ts (uses validation, types)
│   └── parser.ts (uses types)
├── patcher/
│   ├── custom-patcher.ts (uses utils/parser, utils/validation, types)
│   ├── edit-operations.ts (uses utils/validation, types)
│   └── candidate.ts (uses custom-patcher, edit-operations, constants)
├── analyzer/
│   ├── code-analyzer.ts (uses types)
│   └── suggestions.ts (uses code-analyzer, types)
└── state/
    ├── checkpoints.ts (uses types)
    └── baseline.ts (uses types)
```

## Implementation Progress

- [x] Core types (`types.ts`)
- [x] Constants (`constants.ts`)
- [x] Validation utils (`utils/validation.ts`)
- [x] Command utils (`utils/command.ts`)
- [x] Scoring utils (`utils/scoring.ts`)
- [x] Parser utils (`utils/parser.ts`)
- [ ] Patcher modules (`patcher/*.ts`)
- [ ] Analyzer modules (`analyzer/*.ts`)
- [ ] State modules (`state/*.ts`)
- [ ] Refactored server (`server.ts`)

## Migration Strategy

1. **Phase 1: Core Infrastructure** ✅
   - Create types, constants, and basic utilities
   - No breaking changes to existing code

2. **Phase 2: Feature Modules** (In Progress)
   - Create patcher, analyzer, and state modules
   - Extract logic from server.ts

3. **Phase 3: Server Refactoring**
   - Update server.ts to import from modules
   - Remove duplicated code
   - Test all MCP tools

4. **Phase 4: Testing & Documentation**
   - Add unit tests for each module
   - Update CLAUDE.md with new structure
   - Create module-level documentation

## Code Quality Improvements

### Before Refactoring
- **File size**: 2494 lines
- **Cyclomatic complexity**: 13 functions >10 (validateStartSessionArgs: 32)
- **Deep nesting**: 12 functions >4 levels
- **Testability**: Low (monolithic structure)

### After Refactoring (Target)
- **Average module size**: ~150 lines
- **Cyclomatic complexity**: All functions <10
- **Nesting depth**: All functions ≤3 levels
- **Testability**: High (independent modules)

## Next Steps

1. Complete remaining patcher, analyzer, and state modules
2. Refactor server.ts to use new modules
3. Run build to ensure no TypeScript errors
4. Test all 13 MCP tools
5. Add unit tests for critical modules
6. Update documentation
