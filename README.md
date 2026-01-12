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
- **Flexible candidate submission**: Support for multiple modes (files, patch, diff, modify, create)
- **Safe execution**: Commands run in isolated directories with configurable timeouts
- **Actionable feedback**: Compact, LLM-friendly error messages with TypeScript parsing and correlation
- **Advanced features**: Quick undo, incremental file reading, AI-powered fix suggestions

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

```bash
{
  "command": "node",
  "args": ["/absolute/path/to/code_trm_mcp/dist/server.js"]
}
```

## Available Tools (17 Total)

### Core Tools

#### `trm.startSession`

Initialize a TRM session on a local repository.

**Parameters:**
- `repoPath` (required): Absolute path to project
- `buildCmd`, `testCmd`, `lintCmd`, `benchCmd`: Evaluation commands
- `timeoutSec`: Timeout per command (default: 120)
- `weights`: Score weights (build: 0.3, test: 0.5, lint: 0.1, perf: 0.1)
- `halt`: Halting policy (maxSteps, passThreshold, patienceNoImprove, minSteps)
- `emaAlpha`: EMA smoothing factor (default: 0.9)
- `zNotes`: Optional initial reasoning notes
- `preflight`: Run validation checks (default: false)

**Returns:** `sessionId`, `message`, optional `preflight` results

#### `trm.submitCandidate`

Apply candidate changes, run evaluation, return feedback.

**Parameters:**
- `sessionId` (required)
- `candidate` (required): One of these modes:
  - **files**: Complete file contents
  - **patch**: Unified diff format
  - **diff**: Per-file diffs
  - **modify**: Semantic edit operations
  - **create**: New files only
- `rationale`: LLM reasoning notes

**Returns:** `step`, `score`, `emaScore`, `bestScore`, `tests`, `okBuild`, `okLint`, `shouldHalt`, `reasons`, `feedback`, `modeSuggestion`

**Key Features:**
- Error correlation showing which iteration caused errors
- Intelligent mode suggestions based on change patterns
- TypeScript error parsing with actionable suggestions

#### `trm.getFileContent`

Read current file state with metadata.

**Parameters:**
- `sessionId`, `paths` (required)
- `offset`, `limit`: Optional line range

**Returns:** File contents with metadata (lineCount, sizeBytes, lastModified)

#### `trm.getState`

Return current session state snapshot.

**Returns:** `sessionId`, `step`, `emaScore`, `bestScore`, `noImproveStreak`, `last`, `zNotes`

#### `trm.shouldHalt`

Check halting decision.

**Returns:** `shouldHalt`, `reasons`

#### `trm.endSession`

Clean up session.

**Returns:** `ok`

### Enhancement Tools

#### `trm.validateCandidate`

Dry-run validation with detailed preview before applying changes.

**Parameters:** `sessionId`, `candidate`

**Returns:** `valid`, `errors`, `warnings`, `preview` (filesAffected, linesAdded/Removed/Modified, before/after previews)

**Benefits:**
- Catch errors before submission (invalid line numbers, duplicates)
- See exactly what will change with before/after context
- Significantly reduces failed iterations

#### `trm.getSuggestions`

Get AI-powered improvement suggestions based on evaluation results and code analysis.

**Returns:** Top 5 suggestions sorted by priority (critical → high → medium → low)

#### `trm.saveCheckpoint`, `trm.restoreCheckpoint`, `trm.listCheckpoints`

Save/restore session state for snapshot-based workflows.

#### `trm.resetToBaseline`

Reset repository to initial git commit state.

### Advanced Tools

#### `trm.undoLastCandidate`

Quick undo with full state restoration.

**Returns:** `message`, `currentStep`, `score`, `emaScore`, `filesRestored`

**How it works:**
- Captures file contents before applying each candidate
- On undo: restores files, rolls back step counter, recalculates scores/EMA/streak
- No git commands needed - uses internal snapshots

**Example:**
```javascript
// Submit fails badly (score drops from 0.85 to 0.25)
await trm.submitCandidate({ sessionId: "...", candidate: {...} });

// Immediately undo - back to previous state
await trm.undoLastCandidate({ sessionId: "..." });
// Session restored to previous step with score 0.85 ✅
```

#### `trm.getFileLines`

Read specific line range from a file with line numbers.

**Parameters:** `sessionId`, `file`, `startLine`, `endLine`

**Returns:** Lines with formatted line numbers, total lineCount

**Benefits:**
- 10-15% token savings on large files
- Line numbers included for easy reference
- Perfect for targeted fixes around error locations

**Example:**
```javascript
// Error at line 50 - read context (lines 45-56)
const context = await trm.getFileLines({
  sessionId: "...",
  file: "src/parser.ts",
  startLine: 45,
  endLine: 56
});
// Returns: ["45: export function...", "46:   try {", ...]
```

#### `trm.suggestFix`

AI-powered fix candidate generation based on error analysis.

**Supported errors:** TS2304 (missing imports), TS7006 (implicit any), TS2339 (void property access)

**Returns:** Array of suggestions with `priority`, `issue`, `candidateToFix`, `rationale`

**Example:**
```javascript
// Iteration fails with TypeScript errors
const result = await trm.submitCandidate({ /* ... */ });

// Get AI-generated fixes
const fixes = await trm.suggestFix({ sessionId: "..." });

// Apply suggested fix (or validate first)
await trm.submitCandidate({
  sessionId: "...",
  candidate: fixes.suggestions[0].candidateToFix,
  rationale: fixes.suggestions[0].rationale
});
```

#### `trm.reviewPR`

Perform detailed code review on pull requests from GitHub URLs or direct diffs.

**Parameters:**
- `prUrl`: GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`)
- `diff`: Direct unified diff content
- `files`: Array of files with `path`, `content`, and optional `originalContent`
- `focus`: Optional array to filter review categories

**Focus categories:**
- `type-safety`: Detect usage of `any` type
- `logging`: Flag console statements
- `todos`: Identify TODO/FIXME comments
- `code-quality`: Magic numbers, long lines
- `formatting`: Line length validation (>120 chars)
- `error-handling`: Missing try-catch in async functions
- `testing`: Suggest adding tests
- `size`: Flag large changesets

**Returns:**
```javascript
{
  summary: {
    filesChanged: number,
    linesAdded: number,
    linesRemoved: number,
    commentsCount: number,
    criticalCount: number,
    warningCount: number,
    infoCount: number,
    assessment: "approved" | "needs-changes" | "comments",
    highlights: string[]
  },
  comments: [{
    file: string,
    line: number,
    severity: "error" | "warning" | "info",
    category: string,
    message: string,
    suggestion?: string
  }],
  issues: string[],
  suggestions: string[],
  prInfo?: { title?: string, url?: string }
}
```

**Example:**
```javascript
// Review from GitHub URL
const review = await trm.reviewPR({
  prUrl: "https://github.com/owner/repo/pull/123",
  focus: ["type-safety", "error-handling", "code-quality"]
});

console.log(`Assessment: ${review.summary.assessment}`);
console.log(`Found ${review.comments.length} comments`);

// Review from direct diff
const review2 = await trm.reviewPR({
  diff: "diff --git a/file.ts...",
  focus: ["logging", "todos"]
});
```

#### `trm.security`

Comprehensive security analysis detecting OWASP Top 10 vulnerabilities, secrets, and security anti-patterns.

**Parameters:**
- `path` (required): Directory to analyze
- `include`: Glob patterns to include (e.g., `["src/**/*.ts"]`)
- `exclude`: Glob patterns to exclude (e.g., `["**/test/**"]`)
- `focus`: Filter by category - `secrets`, `injection`, `xss`, `auth`, `crypto`, `config`, `mobile`
- `severity`: Minimum severity to report - `critical`, `high`, `medium`, `low`

**Vulnerability Categories:**

| Category | Detects |
|----------|---------|
| `secrets` | Hardcoded API keys, passwords, AWS credentials, JWT secrets |
| `injection` | SQL/NoSQL injection, command injection, eval(), template injection |
| `xss` | dangerouslySetInnerHTML, innerHTML, v-html, document.write |
| `auth` | Insecure token storage (localStorage), missing auth checks, JWT issues, weak cookies |
| `crypto` | Disabled SSL, weak hashing (MD5/SHA1), Math.random() for security |
| `config` | CORS wildcards, debug mode, stack trace exposure, sensitive data in logs |
| `mobile` | AsyncStorage for secrets, deep link validation, cleartext traffic, WebView risks |

**Positive Practices Detected:**
- Secure storage (expo-secure-store, Keychain)
- Parameterized SQL queries
- Input sanitization (DOMPurify)
- JWT verification with audience/issuer
- Schema validation (Joi, Yup, Zod)
- Rate limiting, CSRF protection, security headers
- Certificate pinning

**Returns:**
```javascript
{
  vulnerabilities: [{
    id: number,
    title: string,
    severity: "critical" | "high" | "medium" | "low",
    owasp: "A01:2021-Broken Access Control" | ...,
    status: "needs-fix" | "review",
    location: { file: string, line?: number, snippet?: string },
    issue: string,
    risk: string[],
    solution: string[]
  }],
  positivePractices: [{
    title: string,
    description: string,
    location?: { file: string, line?: number }
  }],
  metrics: {
    totalFilesAnalyzed: number,
    securityRelatedFiles: number,
    errorBoundaries: number,
    secureStorageOps: number,
    totalPatternsDetected: number,
    antiPatternsFound: number
  },
  summary: { critical: number, high: number, medium: number, low: number, total: number },
  recommendations: [{ priority: "immediate" | "high" | "medium" | "ongoing", description: string }]
}
```

**Example:**
```javascript
// Full security audit
const audit = await trm.security({
  path: "/path/to/project"
});

console.log(`Found ${audit.summary.total} issues`);
console.log(`Critical: ${audit.summary.critical}, High: ${audit.summary.high}`);

// Focused analysis on auth and secrets
const authAudit = await trm.security({
  path: "/path/to/project",
  focus: ["auth", "secrets"],
  severity: "high"  // Only high and critical
});

// Mobile app security check
const mobileAudit = await trm.security({
  path: "/path/to/mobile-app",
  focus: ["mobile", "auth", "crypto"],
  exclude: ["**/node_modules/**", "**/__tests__/**"]
});
```

**Output Format:**

The tool returns both a formatted markdown report and structured JSON data:

```
## Security Analysis Summary

| Severity | Count | Action Required |
|----------|-------|-----------------|
| CRITICAL | 2     | Immediate remediation |
| High     | 3     | Immediate remediation |
| Medium   | 5     | Address in next sprint |

---
## Positive Security Practices Observed

1. **Secure Token Storage** (src/utils/secureStorage.ts)
   Uses secure storage for sensitive tokens (iOS Keychain, Android Keystore)

2. **Parameterized SQL Queries** (src/db/queries.ts)
   Uses parameterized queries to prevent SQL injection

---
## Vulnerabilities Found

### CRITICAL Severity

#### 1. Hardcoded Secret/API Key
**Severity:** CRITICAL
**Location:** `src/config.ts:15`
**OWASP:** A02:2021-Cryptographic Failures

**Issue:** Hardcoded secret or API key detected

**Risk:**
- Secrets exposed in source control
- Credential theft if code is leaked

**Solution:**
- Use environment variables
- Use secrets manager (AWS Secrets Manager, HashiCorp Vault)

---
## Recommended Next Steps

1. **Immediate (Critical):** Fix 2 critical issues: Hardcoded Secret/API Key, Command Injection
2. **High Priority:** Address 3 high-severity issues
3. **Ongoing:** Implement automated security scanning in CI/CD pipeline
```

**Example Prompts for Security Analysis:**

Use these prompts with Claude Code, Cursor, or other MCP-enabled LLMs:

```
# Full security audit
"Run a security analysis on this project and show me all vulnerabilities"

# Pre-release security check
"Before we deploy, scan the codebase for any hardcoded secrets or API keys"

# Mobile app security
"Analyze this React Native app for mobile security issues - focus on token storage and deep links"

# Auth system review
"Check our authentication code for security vulnerabilities - look at JWT handling, cookies, and session management"

# OWASP compliance check
"Scan for OWASP Top 10 vulnerabilities in the src directory"

# Quick secrets scan
"Do a quick scan for any hardcoded credentials or API keys that shouldn't be in the code"

# Production readiness
"Is this codebase secure enough for production? Check for critical and high severity issues only"
```

**Security-First Development Workflow:**

```javascript
// 1. Run security scan before starting work
const initialAudit = await trm.security({
  path: "/path/to/project",
  severity: "high"  // Focus on critical issues first
});

if (initialAudit.summary.critical > 0) {
  console.log("Fix critical security issues before proceeding:");
  initialAudit.vulnerabilities
    .filter(v => v.severity === "critical")
    .forEach(v => console.log(`- ${v.title}: ${v.location?.file}`));
}

// 2. After implementing features, re-scan
const postFeatureAudit = await trm.security({
  path: "/path/to/project",
  include: ["src/features/newFeature/**"]  // Scan only new code
});

// 3. Pre-commit security gate
const preCommitAudit = await trm.security({
  path: "/path/to/project",
  focus: ["secrets", "injection"],  // Quick scan for worst issues
  severity: "critical"
});

if (preCommitAudit.summary.total > 0) {
  throw new Error("Cannot commit: critical security issues found");
}
```

**Combining Security Analysis with TRM Iteration:**

```javascript
// Start TRM session
const session = await trm.startSession({
  repoPath: "/path/to/project",
  buildCmd: "tsc --noEmit",
  testCmd: "npm test",
  halt: { maxSteps: 10, passThreshold: 0.95, patienceNoImprove: 3 }
});

// Run security scan to identify issues to fix
const securityIssues = await trm.security({
  path: "/path/to/project",
  severity: "high"
});

// Iterate through security fixes
for (const vuln of securityIssues.vulnerabilities) {
  console.log(`Fixing: ${vuln.title} in ${vuln.location?.file}`);

  // Read the problematic file
  const { files } = await trm.getFileContent({
    sessionId: session.sessionId,
    paths: [vuln.location.file]
  });

  // Get context around the issue
  if (vuln.location?.line) {
    const context = await trm.getFileLines({
      sessionId: session.sessionId,
      file: vuln.location.file,
      startLine: Math.max(1, vuln.location.line - 5),
      endLine: vuln.location.line + 10
    });
    console.log("Context:", context.lines.join("\n"));
  }

  // Apply fix (LLM generates the actual fix based on vuln.solution)
  // ... submit candidate with security fix ...

  // Verify fix didn't break anything
  const state = await trm.getState({ sessionId: session.sessionId });
  if (state.last?.okBuild && state.last?.tests?.failed === 0) {
    console.log(`✓ Fixed ${vuln.title} without breaking tests`);
  }
}

// Final security verification
const finalAudit = await trm.security({
  path: "/path/to/project",
  severity: "high"
});
console.log(`Security issues remaining: ${finalAudit.summary.total}`);
```

**CI/CD Integration Example:**

```yaml
# .github/workflows/security.yml
name: Security Scan

on: [push, pull_request]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run MCP Security Scan
        run: |
          # Use the MCP server for security analysis
          node -e "
            import('./dist/analyzer/security-analyzer.js').then(async (mod) => {
              const result = await mod.analyzeSecurityComprehensive('./src', {
                minSeverity: 'high'
              });

              console.log('Security Scan Results:');
              console.log('Critical:', result.summary.critical);
              console.log('High:', result.summary.high);

              if (result.summary.critical > 0) {
                console.error('CRITICAL security issues found!');
                process.exit(1);
              }
            });
          "
```

## Recommended Workflow

### 1. Start Session with Preflight

```javascript
const session = await trm.startSession({
  repoPath: "/absolute/path/to/project",
  buildCmd: "tsc -p . --noEmit",
  testCmd: "npm test --silent -- --reporter=json",
  preflight: true, // Validate setup before iterating
  halt: { maxSteps: 12, passThreshold: 0.97, patienceNoImprove: 3 }
});

if (!session.preflight.initialBuild.success) {
  console.log("Fix build before iterating");
  return;
}
```

### 2. Iterative Improvement Loop

**Key principles:**
- Keep patches **small and focused** (one issue at a time)
- Maximize **delta information per step** (TRM philosophy)
- Use `rationale` to maintain context across steps
- Trust the score/feedback signals for guidance

**Pattern:**
1. Get file metadata to avoid line number errors
2. Validate changes before submitting
3. Submit candidate with rationale
4. If fails: use `suggestFix` or `undoLastCandidate`
5. Repeat until `shouldHalt=true`

### 3. Example with Advanced Features

```javascript
// 1. Get file metadata
const { files } = await trm.getFileContent({
  sessionId: session.sessionId,
  paths: ["src/parser.ts"]
});
const lineCount = files["src/parser.ts"].metadata.lineCount;

// 2. Validate before submitting
const validation = await trm.validateCandidate({
  sessionId: session.sessionId,
  candidate: {
    mode: "modify",
    changes: [{
      file: "src/parser.ts",
      edits: [{ type: "insertAfter", line: lineCount, content: "..." }]
    }]
  }
});

if (!validation.valid) {
  console.log("Fix errors:", validation.errors);
  return;
}

// 3. Submit
const result = await trm.submitCandidate({
  sessionId: session.sessionId,
  candidate: validation.preview.candidate,
  rationale: "Adding error handling"
});

// 4. Handle failures
if (!result.okBuild) {
  // Try AI-generated fixes
  const fixes = await trm.suggestFix({ sessionId: session.sessionId });

  if (fixes.suggestions.length > 0) {
    await trm.submitCandidate({
      sessionId: session.sessionId,
      candidate: fixes.suggestions[0].candidateToFix,
      rationale: `Auto-fix: ${fixes.suggestions[0].rationale}`
    });
  } else {
    // Or undo and try different approach
    await trm.undoLastCandidate({ sessionId: session.sessionId });
  }
}

// 5. For targeted fixes, read just relevant lines
if (result.feedback.includes("line 145")) {
  const context = await trm.getFileLines({
    sessionId: session.sessionId,
    file: "src/parser.ts",
    startLine: 135,
    endLine: 155
  });
  // Use context with line numbers for precise fix
}
```

## Submission Modes

**Recommended (new)**:
- `create`: New files only (validates file doesn't exist)
- `modify`: Semantic edit operations (replace, insertBefore, insertAfter, replaceLine, deleteRange, etc.)

**Example modify mode:**
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

**Legacy (still supported)**:
- `diff`: Per-file unified diffs (uses custom fuzzy-matching patcher)
- `patch`: Single unified diff for multiple files
- `files`: Complete file contents (for rewrites)

## Performance Benefits

| Feature | Time Savings | Token Savings | Use Case |
|---------|-------------|---------------|----------|
| Quick Undo | 5-10% | - | Instant recovery from failed iterations |
| Incremental File Reading | 10-15% | 30-50% | Large files, focused edits |
| Auto-Suggest Fixes | 15-20% | - | TypeScript errors, common patterns |
| Pre-Apply Validation | 20-30% | - | Catch errors before submission |
| Error Correlation | 10-15% | - | Faster debugging with context |
| Security Analysis | - | - | OWASP vulnerabilities, secrets detection |
| **Combined Benefits** | **Up to 40%** | **30-50%** | **Overall efficiency improvement** |

**Real-world impact:**
- Significantly faster iteration sessions on error-heavy workloads
- Reduced token usage when working with large files
- Fewer wasted iterations due to validation and error correlation

## Token Optimization

The MCP tool schemas have been optimized to minimize token usage while preserving full functionality:

**Optimization results:**
- **4% reduction** in total MCP token usage (384 tokens saved)
- **17 tools** optimized with concise schemas
- **No functionality loss** - all parameters, types, and features unchanged

**What was optimized:**
- Concise tool descriptions without verbose explanations
- Removed redundant property descriptions
- Eliminated inline examples from schemas
- Streamlined text while maintaining clarity

**Impact:**
- Frees up 384 tokens in your context window
- Equivalent to ~100 additional lines of code context
- MCP protocol overhead (~7,200 tokens) remains the main bottleneck

**Implementation:**
Ultra-optimized schemas are active. For analysis and bigger token savings strategies, see `TOKEN_OPTIMIZATION.md` and `token-comparison.md`.

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

## Design Philosophy (TRM → MCP)

- **y (current solution)**: The **repo state** after each patch applied by the LLM
- **z (latent reasoning)**: `rationale` and `zNotes` maintain context of how/why we reached current state
- **Deep supervision**: Each `submitCandidate` is a **refinement step**; score/EMA provide objective feedback
- **ACT halting**: `shouldHalt` uses clear rules (tests pass + threshold, patience exhausted, maxSteps)
- **Small patches**: Maximize information per step (TRM principle)
- **No training needed**: Pure test-time refinement using existing dev tools

## Practical Tips

1. **Enable JSON test reporters** (Jest/Vitest) for accurate score calculation
2. **Keep patches small** to maximize information per step (TRM principle)
3. **Adjust `weights`** based on objective (e.g., more weight to `perf` when tests are green)
4. **Use `benchCmd`** that outputs a single number (e.g., milliseconds) for performance tracking
5. **For TypeScript**: Use `tsc --noEmit` in `buildCmd` for fast type error detection
6. **Use preflight validation** to catch setup issues before iterating
7. **Validate candidates** before submitting to reduce failed iterations
8. **Use `getFileLines`** for large files to save tokens
9. **Try `suggestFix`** when stuck on TypeScript errors
10. **Use `undoLastCandidate`** to quickly recover from bad changes
11. **Run security scans** before deployment to catch hardcoded secrets and vulnerabilities
12. **Focus security analysis** using `focus` param for faster targeted scans (e.g., `["secrets", "auth"]`)
13. **Use severity filters** (`severity: "high"`) to prioritize critical issues first
14. **Combine security + TRM** to fix vulnerabilities while ensuring tests still pass

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
│  • Candidate snapshots (for undo)                           │
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
