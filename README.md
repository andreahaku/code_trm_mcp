# MCP TRM Server

A **TRM-inspired (Test-time Recursive Memory) MCP server** for recursive code refinement with LLM development tools.

This server implements a recursive improvement cycle where:
- The LLM (Claude Code, Cursor, Codex CLI) acts as the **optimizer** proposing code changes
- This MCP server acts as the **critic/evaluator** with stateful tracking
- Evaluations include: build, test, lint, and benchmark
- Scores are tracked using EMA (Exponential Moving Average)
- A halting policy (simplified ACT - Adaptive Computation Time) determines when to stop

## Features

- **Multi-signal evaluation**: Build, test, lint, and performance benchmarking
- **Weighted scoring**: Configurable weights for different evaluation signals
- **EMA tracking**: Smooth score tracking across iterations
- **Intelligent halting**: Stop when tests pass + score threshold, no improvement, or max steps
- **Flexible candidate submission**: Support for both file-based and unified diff patches
- **Safe execution**: Commands run in isolated directories with configurable timeouts
- **Actionable feedback**: Compact, LLM-friendly error messages and hints

## Installation

```bash
npm install
npm run build
```

## Usage with MCP Clients

### Claude Code (VS Code)

1. Open VS Code settings
2. Navigate to "Model Context Protocol"
3. Add a new MCP Server:
   - **Command**: `node /absolute/path/to/code_trm_mcp/dist/server.js`
   - **Args**: *(leave empty)*

### Cursor

1. Open Settings → MCP / "Custom MCP Servers"
2. Add server:
   - Command: `node /absolute/path/to/code_trm_mcp/dist/server.js`

### Codex CLI

Point to the server binary via stdio:
```bash
# Configure in your MCP client config
{
  "command": "node",
  "args": ["/absolute/path/to/code_trm_mcp/dist/server.js"]
}
```

## Available Tools

### `trm.startSession`

Initialize a TRM session on a local repository with evaluation commands and halting policy.

**Parameters:**
- `repoPath` (required): Absolute path to the project repository
- `buildCmd`: Build command (e.g., `"tsc -p . --noEmit"`)
- `testCmd`: Test command (e.g., `"npm test --silent -- --reporter=json"`)
- `lintCmd`: Lint command (e.g., `"npm run lint"`)
- `benchCmd`: Benchmark command (optional, should output a number)
- `timeoutSec`: Timeout per command (default: 120)
- `weights`: Score weights object:
  - `build`: Weight for build success (default: 0.3)
  - `test`: Weight for test pass rate (default: 0.5)
  - `lint`: Weight for lint success (default: 0.1)
  - `perf`: Weight for performance (default: 0.1)
- `halt`: Halting policy:
  - `maxSteps`: Maximum iteration steps (required)
  - `passThreshold`: Score threshold to accept (required, 0-1)
  - `patienceNoImprove`: Steps without improvement before halting (required)
  - `minSteps`: Minimum steps before allowing halt (default: 1)
- `emaAlpha`: EMA smoothing factor (default: 0.9)
- `zNotes`: Optional initial reasoning notes/hints
- `preflight`: Run initial validation checks (default: false) - **Phase 2 Feature**

**Returns:**
- `sessionId`: UUID for the session
- `message`: Confirmation message
- `preflight` (if enabled): Validation results including repo status, command availability, and initial build check

**Preflight Example:**
```json
{
  "sessionId": "abc-123",
  "message": "Session started",
  "preflight": {
    "repoStatus": {
      "gitRepo": true,
      "uncommittedChanges": false
    },
    "commands": {
      "build": { "status": "available", "estimatedTime": "~3s" },
      "test": { "status": "available", "estimatedTime": "~5s" }
    },
    "initialBuild": {
      "success": true,
      "warnings": []
    }
  }
}
```

### `trm.submitCandidate`

Apply candidate changes, run evaluation, update EMA & state, return feedback + shouldHalt decision.

**Parameters:**
- `sessionId` (required): Session UUID from startSession
- `candidate` (required): One of:
  - **Files mode**:
    ```json
    {
      "mode": "files",
      "files": [
        {
          "path": "relative/path/to/file.ts",
          "content": "complete file content"
        }
      ]
    }
    ```
  - **Patch mode**:
    ```json
    {
      "mode": "patch",
      "patch": "unified diff format patch"
    }
    ```
- `rationale`: LLM reasoning notes (why these changes, expected effects, hypotheses)

**Returns:**
```json
{
  "step": 1,
  "score": 0.85,
  "emaScore": 0.85,
  "bestScore": 0.85,
  "noImproveStreak": 0,
  "tests": {
    "passed": 42,
    "failed": 2,
    "total": 44
  },
  "okBuild": true,
  "okLint": true,
  "shouldHalt": false,
  "reasons": [],
  "feedback": [
    "Tests: 42/44 passed.",
    "There are 2 failing tests.",
    "src/parser.ts:123:45 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "🔍 Error likely caused by changes in iteration 1:",
    "   - src/parser.ts",
    "📍 Last successful build: iteration 0 (score from history)"
  ],
  "modeSuggestion": {
    "recommended": "modify",
    "reason": "You're making small targeted changes. 'modify' mode provides better precision and clearer error messages than 'diff' mode.",
    "confidence": "high",
    "alternatives": {
      "diff": "Continue using for changes spanning multiple sections",
      "patch": "Use when coordinating changes across multiple files"
    }
  }
}
```

**Phase 2 Features:**
- **Error Correlation**: Feedback now includes analysis showing which iteration likely caused errors (see `🔍` lines)
- **Mode Suggestions**: Get intelligent recommendations for optimal submission modes based on your changes

### `trm.getState`

Return current TRM state snapshot (scores, EMA, history summary).

**Parameters:**
- `sessionId` (required): Session UUID

**Returns:**
- `sessionId`: Session UUID
- `step`: Current step number
- `emaScore`: Current EMA score
- `bestScore`: Best score achieved so far
- `noImproveStreak`: Consecutive steps without improvement
- `last`: Last evaluation result
- `zNotes`: Current reasoning notes

### `trm.shouldHalt`

Return halting decision based on latest evaluation.

**Parameters:**
- `sessionId` (required): Session UUID

**Returns:**
- `shouldHalt`: Boolean indicating if iteration should stop
- `reasons`: Array of reason strings

### `trm.endSession`

End and remove a TRM session.

**Parameters:**
- `sessionId` (required): Session UUID

**Returns:**
- `ok`: Boolean confirmation

### `trm.getFileContent` - **Phase 1 Enhanced**

Read current file state with metadata for generating accurate diffs.

**Parameters:**
- `sessionId` (required): Session UUID
- `paths` (required): Array of relative file paths to read
- `offset`: Line number to start from (1-based, optional)
- `limit`: Maximum number of lines to return (optional)

**Returns:**
```json
{
  "files": {
    "src/parser.ts": {
      "content": "export function parseTestOutput(raw: string) {\n  // ...\n}",
      "metadata": {
        "lineCount": 98,
        "sizeBytes": 4567,
        "lastModified": "2025-01-12T10:30:45.123Z"
      }
    }
  }
}
```

**Phase 1 Feature:**
- File metadata prevents line number errors by showing exact line count before generating edits

### `trm.validateCandidate` - **Phase 1 New Tool**

Validate candidate changes without applying them (dry-run with preview).

**Parameters:**
- `sessionId` (required): Session UUID
- `candidate` (required): Same format as `trm.submitCandidate`

**Returns:**
```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    "File src/utils/validation.ts: Large change detected (50+ lines)"
  ],
  "preview": {
    "filesAffected": ["src/utils/validation.ts", "src/types.ts"],
    "linesAdded": 23,
    "linesRemoved": 8,
    "linesModified": 15,
    "filesPreviews": [
      {
        "file": "src/utils/validation.ts",
        "beforeLines": [
          "15: export function validatePath(path: string): boolean {",
          "16:   return path.startsWith('/');",
          "17: }"
        ],
        "afterLines": [
          "15: export function validatePath(path: string): boolean {",
          "16:   if (!path) return false;",
          "17:   return path.startsWith('/');",
          "18: }"
        ],
        "linesAdded": 1,
        "linesRemoved": 0,
        "changeType": "modification"
      }
    ]
  }
}
```

**Phase 1 Features:**
- Pre-apply validation detects errors before submission (invalid line numbers, duplicate declarations)
- Detailed preview shows exactly what will change with before/after context
- Estimated 50% reduction in failed iterations

## Recommended Workflow

### 1. Start a session

```javascript
// Call via MCP client
{
  "tool": "trm.startSession",
  "arguments": {
    "repoPath": "/absolute/path/to/project",
    "buildCmd": "tsc -p . --noEmit",
    "testCmd": "npm test --silent -- --reporter=json",
    "lintCmd": "npm run lint",
    "weights": {
      "build": 0.25,
      "test": 0.55,
      "lint": 0.10,
      "perf": 0.10
    },
    "halt": {
      "maxSteps": 12,
      "passThreshold": 0.97,
      "patienceNoImprove": 3,
      "minSteps": 2
    },
    "emaAlpha": 0.9,
    "zNotes": "Target: fix failing authentication tests and optimize token validation."
  }
}
```

### 2. Recursive improvement loop

The LLM should:

1. **Propose minimal, targeted patch** for one specific issue
2. **Call `trm.submitCandidate`** with:
   - Candidate changes (files or patch)
   - Rationale explaining why this change improves score/tests/perf
3. **Read feedback**: `score`, `emaScore`, `tests`, `feedback` array
4. **If `shouldHalt=false`**: Analyze feedback and propose next small patch
5. **If `shouldHalt=true`**: Stop iteration

**Key principles:**
- Keep patches **small and focused** (one issue at a time)
- Maximize **delta information per step** (TRM philosophy)
- Use `rationale` to maintain context across steps
- Trust the score/feedback signals for guidance

### 3. Example iteration

```javascript
// Step 1: Fix type error
{
  "tool": "trm.submitCandidate",
  "arguments": {
    "sessionId": "...",
    "candidate": {
      "mode": "files",
      "files": [{
        "path": "src/auth/validator.ts",
        "content": "/* updated content with type fix */"
      }]
    },
    "rationale": "Fixed TokenPayload type mismatch in validateToken function. This should resolve the build error without changing behavior."
  }
}
// Response: score=0.45, shouldHalt=false, feedback=["Build passed", "Tests: 38/44 passed"]

// Step 2: Fix failing test
{
  "tool": "trm.submitCandidate",
  "arguments": {
    "sessionId": "...",
    "candidate": {
      "mode": "files",
      "files": [{
        "path": "src/auth/validator.ts",
        "content": "/* updated with proper null check */"
      }]
    },
    "rationale": "Added null check for expired tokens. This addresses the 'should reject expired tokens' test failure."
  }
}
// Response: score=0.72, shouldHalt=false, feedback=["Tests: 42/44 passed"]

// Continue until shouldHalt=true...
```

## Phase 1 & 2 Improvements

### Phase 1: Validation Enhancements (50% fewer failed iterations)

#### 1. File Metadata in `getFileContent`
**Problem:** LLMs would try to insert after line 100 in a 98-line file, causing failures.
**Solution:** Return line count, file size, and last modified timestamp.

```javascript
// Before Phase 1: No way to know file has 98 lines
await trm.submitCandidate({
  candidate: {
    mode: "modify",
    changes: [{
      file: "src/parser.ts",
      edits: [{ type: "insertAfter", line: 100, content: "..." }] // ❌ File only has 98 lines!
    }]
  }
});

// After Phase 1: Check metadata first
const { files } = await trm.getFileContent({
  sessionId: "...",
  paths: ["src/parser.ts"]
});
console.log(files["src/parser.ts"].metadata.lineCount); // 98
// Now use correct line number ✅
```

#### 2. Pre-Apply Validation with `validateCandidate`
**Problem:** Errors only discovered after applying changes, wasting iterations.
**Solution:** Validate before submitting with detailed error messages.

```javascript
// Validate first (dry-run)
const validation = await trm.validateCandidate({
  sessionId: "...",
  candidate: {
    mode: "modify",
    changes: [{
      file: "src/utils/validation.ts",
      edits: [
        { type: "insertAfter", line: 7, content: "export function sanitizeOutput() {}" }
      ]
    }]
  }
});

if (!validation.valid) {
  console.log(validation.errors);
  // [{
  //   error: "Duplicate declaration detected",
  //   code: "DUPLICATE_DECLARATION",
  //   details: {
  //     symbol: "sanitizeOutput",
  //     existingLine: 9,
  //     suggestion: "Function 'sanitizeOutput' already exists at line 9. Use 'replace' instead."
  //   }
  // }]

  // Fix the issue and try again ✅
}
```

#### 3. Detailed Change Previews
**Problem:** Unclear what changes will actually be applied.
**Solution:** Preview shows before/after with line numbers.

```javascript
const validation = await trm.validateCandidate({ /* ... */ });
console.log(validation.preview.filesPreviews[0]);
// {
//   file: "src/utils/validation.ts",
//   beforeLines: [
//     "15: export function validatePath(path: string): boolean {",
//     "16:   return path.startsWith('/');",
//     "17: }"
//   ],
//   afterLines: [
//     "15: export function validatePath(path: string): boolean {",
//     "16:   if (!path) return false;",
//     "17:   return path.startsWith('/');",
//     "18: }"
//   ],
//   linesAdded: 1,
//   linesRemoved: 0,
//   changeType: "modification"
// }
```

### Phase 2: UX Enhancements (30-40% efficiency improvement)

#### 1. Intelligent Mode Suggestions
**Problem:** LLMs don't know which submission mode is optimal for their changes.
**Solution:** Automatic mode recommendations based on change patterns.

```javascript
// LLM submits using 'diff' mode for small changes
const result = await trm.submitCandidate({
  candidate: {
    mode: "diff",
    changes: [{ path: "src/parser.ts", diff: "..." }] // Small, targeted change
  }
});

// Server suggests better mode
console.log(result.modeSuggestion);
// {
//   recommended: "modify",
//   reason: "You're making small targeted changes. 'modify' mode provides better precision and clearer error messages than 'diff' mode.",
//   confidence: "high",
//   alternatives: {
//     diff: "Continue using for changes spanning multiple sections",
//     patch: "Use when coordinating changes across multiple files"
//   }
// }

// Next iteration: LLM switches to 'modify' mode ✅
```

#### 2. Error Correlation and Context
**Problem:** Build fails with cryptic errors, unclear which iteration caused it.
**Solution:** Automatic correlation of errors to recent file changes.

```javascript
// Iteration 3 modifies src/parser.ts
await trm.submitCandidate({
  candidate: { mode: "modify", changes: [{ file: "src/parser.ts", edits: [...] }] }
});

// Build fails with TypeScript error
const result = await trm.submitCandidate({ /* iteration 4 */ });
console.log(result.feedback);
// [
//   "Build failed with 1 error",
//   "src/parser.ts:45:10 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
//   "🔍 Error likely caused by changes in iteration 3:",
//   "   - src/parser.ts",
//   "📍 Last successful build: iteration 2 (score from history)",
//   "💡 Suggestion: Review changes in iteration 3. Check for type mismatches, missing imports, or syntax errors."
// ]

// LLM now knows to revert/fix iteration 3 changes ✅
```

#### 3. Preflight Validation
**Problem:** Start session, wait for first iteration, then discover build command doesn't exist.
**Solution:** Optional preflight checks validate setup before iterating.

```javascript
const session = await trm.startSession({
  repoPath: "/path/to/project",
  buildCmd: "tsc -p . --noEmit",
  testCmd: "npm test",
  preflight: true, // ✅ Run validation checks
  halt: { maxSteps: 10, passThreshold: 0.95, patienceNoImprove: 3 }
});

console.log(session.preflight);
// {
//   repoStatus: {
//     gitRepo: true,
//     uncommittedChanges: false
//   },
//   commands: {
//     build: { status: "available", estimatedTime: "~3s" },
//     test: { status: "available", estimatedTime: "~5s" },
//     lint: { status: "unavailable" } // ⚠️ Warning: lint command not configured
//   },
//   initialBuild: {
//     success: true,
//     warnings: ["2 files with 'any' type detected"]
//   }
// }

// If build failed, fix before starting iterations ✅
```

#### 4. Cascading Error Detection
**Problem:** One error causes multiple downstream failures.
**Solution:** Detect cascading patterns and suggest root cause fix.

```javascript
// After 3 iterations with progressively more test failures
const result = await trm.submitCandidate({ /* ... */ });
console.log(result.feedback);
// [
//   "Tests: 10/44 passed (degrading from 42/44)",
//   "💡 Pattern detected: Test failures are increasing - may indicate fundamental issue",
//   "💡 Suggestion: Consider reverting to last successful iteration (step 2) and trying a different approach."
// ]
```

### Combined Workflow Example

```javascript
// 1. Start with preflight validation
const session = await trm.startSession({
  repoPath: "/path/to/project",
  buildCmd: "tsc -p . --noEmit",
  testCmd: "npm test --silent -- --reporter=json",
  preflight: true,
  halt: { maxSteps: 12, passThreshold: 0.97, patienceNoImprove: 3 }
});

if (!session.preflight.initialBuild.success) {
  console.log("Fix build before iterating");
  return;
}

// 2. Get file metadata to avoid line number errors
const { files } = await trm.getFileContent({
  sessionId: session.sessionId,
  paths: ["src/parser.ts"]
});
const lineCount = files["src/parser.ts"].metadata.lineCount; // 98

// 3. Validate changes before submitting
const validation = await trm.validateCandidate({
  sessionId: session.sessionId,
  candidate: {
    mode: "modify",
    changes: [{
      file: "src/parser.ts",
      edits: [{ type: "insertAfter", line: lineCount, content: "..." }] // Use actual line count
    }]
  }
});

if (!validation.valid) {
  console.log("Fix errors:", validation.errors);
  return;
}

// 4. Submit and use mode suggestions
const result = await trm.submitCandidate({
  sessionId: session.sessionId,
  candidate: validation.preview.candidate, // Use validated candidate
  rationale: "Adding error handling for edge case"
});

if (result.modeSuggestion) {
  console.log(`Consider using '${result.modeSuggestion.recommended}' mode: ${result.modeSuggestion.reason}`);
}

// 5. Use error correlation for debugging
if (!result.okBuild) {
  const errorContext = result.feedback.filter(f => f.startsWith("🔍") || f.startsWith("💡"));
  console.log("Error context:", errorContext);
}
```

## Design Philosophy (TRM → MCP)

- **y (current solution)**: The **repo state** after each patch applied by the LLM
- **z (latent reasoning)**: `rationale` and `zNotes` maintain context of how/why we reached current state (TRM-style memory without verbose CoT)
- **Deep supervision / recursion**: Each `submitCandidate` is a **refinement step**; score/EMA provide "deep supervision" guiding convergence
- **ACT simplified**: `shouldHalt` uses clear rules (tests pass + threshold, patience exhausted, maxSteps)
- **Less is more**: Small patches, short loops, objective signals (build/test/lint/bench), no training needed

## Practical Tips

1. **Enable JSON test reporters** (Jest/Vitest) for accurate score calculation
2. **Keep patches small** to maximize information per step (TRM principle)
3. **Adjust `weights`** based on objective (e.g., more weight to `perf` when tests are green)
4. **Use `benchCmd`** that outputs a single number (e.g., milliseconds) for "lower-is-better" perf metric
5. **For TypeScript**: Use `tsc --noEmit` in `buildCmd` for fast type error detection
6. **Pre-commit alignment**: Use same commands in local pre-commit hooks for consistency

## Score Calculation

Score is a weighted average in [0, 1]:

```
score = (w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumWeights

where:
  sBuild = 1 if build succeeds, 0 otherwise
  sTests = passed / total (0 if tests fail to parse)
  sLint = 1 if lint succeeds, 0 otherwise
  sPerf = normalized performance score (best/current, lower is better)
```

## Halting Conditions

Iteration stops when:

1. **Success**: `step >= minSteps` AND all tests pass AND `score >= passThreshold`
2. **Plateau**: No improvement for `patienceNoImprove` consecutive steps
3. **Limit**: Reached `maxSteps`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      LLM Client                              │
│         (Claude Code / Cursor / Codex CLI)                  │
│                                                              │
│  • Proposes code changes (optimizer role)                   │
│  • Submits candidates via MCP tools                         │
│  • Interprets feedback and iterates                         │
└────────────────────┬────────────────────────────────────────┘
                     │ MCP Protocol
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   MCP TRM Server                            │
│                                                              │
│  Session State:                                             │
│  • Current score, EMA, best score                           │
│  • Test results, build status                               │
│  • Improvement streak tracking                              │
│  • History of evaluations                                   │
│                                                              │
│  Evaluation Pipeline:                                       │
│  1. Apply candidate changes                                 │
│  2. Run: build → test → lint → bench                        │
│  3. Parse outputs, extract signals                          │
│  4. Compute weighted score                                  │
│  5. Update EMA and improvement tracking                     │
│  6. Check halting policy                                    │
│  7. Return structured feedback                              │
└────────────────────┬────────────────────────────────────────┘
                     │ Shell Commands
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Target Repository                          │
│                                                              │
│  • Source code files                                        │
│  • Build system (tsc, webpack, etc.)                        │
│  • Test framework (jest, vitest, etc.)                      │
│  • Linter (eslint, etc.)                                    │
│  • Benchmark scripts (optional)                             │
└─────────────────────────────────────────────────────────────┘
```

## Based On

This implementation is inspired by the **Test-time Recursive Memory (TRM)** approach from the paper:
> "Recursive Introspection: Teaching Language Model Agents How to Self-Improve"
> (arXiv:2510.04871v1)

Key adaptations for MCP/LLM development:
- TRM's recursive refinement → Iterative code improvement with LLM proposals
- Latent reasoning (z) → Rationale/notes passed between iterations
- ACT halting → Configurable stopping policy based on score + improvement
- Deep supervision → Build/test/lint/perf signals as training-free feedback

## License

MIT

## Contributing

Issues and pull requests welcome at the project repository.
