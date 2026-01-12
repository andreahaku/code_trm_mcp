/**
 * Type definitions for the TRM MCP server.
 */

export type SessionId = string;

// ============= CORE REQUEST/RESPONSE TYPES =============

export type StartSessionArgs = {
  repoPath: string;
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  benchCmd?: string;
  timeoutSec?: number;
  weights?: {
    build?: number;
    test?: number;
    lint?: number;
    perf?: number;
  };
  halt: {
    maxSteps: number;
    passThreshold: number;
    patienceNoImprove: number;
    minSteps?: number;
  };
  emaAlpha?: number;
  zNotes?: string;
  preflight?: boolean; // Run initial validation checks
};

export type SubmitCandidateArgs = {
  sessionId: string;
  candidate:
    | { mode: "diff"; changes: { path: string; diff: string }[] }
    | { mode: "patch"; patch: string }
    | { mode: "files"; files: { path: string; content: string }[] };
  rationale?: string;
};

export type FileMetadata = {
  lineCount: number;
  sizeBytes: number;
  lastModified: string; // ISO timestamp
};

export type GetFileContentArgs = {
  sessionId: string;
  paths: string[];
  offset?: number;  // Line number to start from (1-based)
  limit?: number;   // Maximum number of lines to return
};

export type FileWithMetadata = {
  content: string;
  metadata: FileMetadata;
};

export type GetFileContentResponse = {
  files: Record<string, FileWithMetadata>;
};

export type SessionIdArgs = {
  sessionId: string;
};

// ============= SESSION STATE TYPES =============

export type SessionConfig = {
  repoPath: string;
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  benchCmd?: string;
  timeoutSec?: number;
  weights: {
    build: number;
    test: number;
    lint: number;
    perf: number;
  };
  halt: {
    maxSteps: number;
    passThreshold: number;
    patienceNoImprove: number;
    minSteps?: number;
  };
};

export type ModeSuggestion = {
  recommended: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  alternatives?: Record<string, string>;
};

export type EvalResult = {
  okBuild?: boolean;
  okLint?: boolean;
  tests?: { passed: number; failed: number; total: number; raw?: string };
  perf?: { value: number; unit?: string };
  score: number;
  emaScore: number;
  step: number;
  feedback: string[];
  shouldHalt: boolean;
  reasons: string[];
  modeSuggestion?: ModeSuggestion;
};

export type SessionMode = "cumulative" | "snapshot";

export type CommandStatus = "available" | "unavailable" | "unknown";

export type Checkpoint = {
  id: string;
  timestamp: number;
  step: number;
  score: number;
  emaScore: number;
  filesSnapshot: Map<string, string>;
  description?: string;
};

export type IterationContext = {
  step: number;
  filesModified: string[];
  mode: string;
  success: boolean;
};

export type CandidateSnapshot = {
  step: number;
  candidate: any; // Store the full candidate submission
  rationale?: string;
  filesBeforeChange: Map<string, string>; // File contents BEFORE this candidate was applied
  evalResult: EvalResult; // Result after applying this candidate
  timestamp: number;
};

export type UndoLastCandidateArgs = {
  sessionId: string;
};

export type GetFileLinesArgs = {
  sessionId: string;
  file: string;
  startLine: number;  // 1-based, inclusive
  endLine: number;    // 1-based, inclusive
};

export type GetFileLinesResponse = {
  file: string;
  lines: string[];      // Lines with line numbers, e.g., "90: function foo() {"
  lineCount: number;    // Total line count of the file
};

export type SuggestFixArgs = {
  sessionId: string;
};

export type FixSuggestion = {
  priority: "critical" | "high" | "medium" | "low";
  issue: string;
  candidateToFix: ModifySubmission | CreateSubmission;  // Ready-to-apply candidate
  rationale: string;
};

export type SuggestFixResponse = {
  suggestions: FixSuggestion[];
};

export type SessionState = {
  id: SessionId;
  cfg: SessionConfig;
  createdAt: number;
  step: number;
  bestScore: number;
  emaScore: number;
  emaAlpha: number;
  noImproveStreak: number;
  history: EvalResult[];
  zNotes?: string;
  bestPerf?: number;
  mode: SessionMode;
  checkpoints: Map<string, Checkpoint>;
  baselineCommit?: string;
  modifiedFiles: Set<string>; // Track files modified in this session for context warnings
  fileSnapshots: Map<string, string>; // Cache of file contents at last read via getFileContent
  commandStatus: {
    build: CommandStatus;
    test: CommandStatus;
    lint: CommandStatus;
    bench: CommandStatus;
  };
  iterationContexts: IterationContext[]; // Track file changes per iteration for error correlation
  candidateSnapshots: CandidateSnapshot[]; // Store candidate data for undo functionality (Phase 3)
};

// ============= ENHANCED API TYPES =============

export type CreateSubmission = {
  mode: "create";
  files: Array<{ path: string; content: string }>;
};

export type ModifySubmission = {
  mode: "modify";
  changes: ModifyChange[];
};

export type ModifyChange = {
  file: string;
  edits: EditOperation[];
};

export type EditOperation =
  | { type: "replace"; oldText: string; newText: string; all?: boolean }
  | { type: "insertBefore"; line: number; content: string }
  | { type: "insertAfter"; line: number; content: string }
  | { type: "replaceLine"; line: number; content: string }
  | { type: "replaceRange"; startLine: number; endLine: number; content: string }
  | { type: "deleteLine"; line: number }
  | { type: "deleteRange"; startLine: number; endLine: number };

export type Suggestion = {
  priority: "critical" | "high" | "medium" | "low";
  category: "type-safety" | "documentation" | "performance" | "test-coverage" | "code-quality" | "security";
  issue: string;
  locations?: Array<{ file: string; line?: number; snippet?: string }>;
  suggestedFix?: string;
  autoFixable: boolean;
};

export type CodeIssue = {
  type: "any-type" | "missing-jsdoc" | "magic-number" | "long-function" | "high-complexity" | "no-error-handling"
      | "large-module" | "deep-nesting" | "impure-function" | "hard-to-mock";
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  column?: number;
  message: string;
  context?: string;
};

export type EnhancedError = {
  error: string;
  code: string;
  details: {
    failedAt?: string;
    reason?: string;
    expected?: string;
    got?: string;
    suggestion?: string;
    context?: string;
    requestedLine?: number;         // For line validation errors
    actualLineCount?: number;       // For line validation errors
    [key: string]: any;             // Allow additional properties for specific error types
  };
};

export type FilePreview = {
  file: string;
  beforeLines: string[];  // Lines with numbers, e.g., "10: const foo = 'bar';"
  afterLines: string[];   // Lines with numbers showing the change
  linesAdded: number;
  linesRemoved: number;
  changeType: "insertion" | "deletion" | "modification" | "replacement";
};

export type ValidationResult = {
  valid: boolean;
  errors: EnhancedError[];
  warnings: string[];
  preview?: {
    filesAffected: string[];
    linesAdded: number;
    linesRemoved: number;
    linesModified: number;
    filesPreviews?: FilePreview[];  // Detailed per-file previews
  };
};

export type ImprovedSubmitCandidateArgs = {
  sessionId: string;
  candidate: CreateSubmission | ModifySubmission;
  rationale?: string;
  dryRun?: boolean;
};

export type SaveCheckpointArgs = {
  sessionId: string;
  description?: string;
};

export type RestoreCheckpointArgs = {
  sessionId: string;
  checkpointId: string;
};

export type ListCheckpointsArgs = {
  sessionId: string;
};

export type ImprovedStartSessionArgs = StartSessionArgs & {
  mode?: SessionMode;
  autoCommit?: boolean;
  autoReset?: boolean;
  autoCheckpoint?: boolean;
};

// ============= UTILITY TYPES =============

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ParsedDiffFile = {
  file: string;
  hunks: ParsedDiffHunk[];
};

export type ParsedDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: "context" | "add" | "remove"; content: string }>;
};

// ============= PR REVIEW TYPES =============

export type PRReviewArgs = {
  prUrl?: string;
  diff?: string;
  files?: Array<{ path: string; content: string; originalContent?: string }>;
  focus?: string[];
};

export type ReviewComment = {
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  category: "type-safety" | "logging" | "todos" | "code-quality" | "formatting" | "error-handling" | "testing" | "size";
  message: string;
  suggestion?: string;
};

export type ReviewSummary = {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commentsCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  assessment: "approved" | "needs-changes" | "comments";
  highlights: string[];
};

export type PRReviewResponse = {
  summary: ReviewSummary;
  comments: ReviewComment[];
  issues: string[];
  suggestions: string[];
  prInfo?: { title?: string; url?: string };
};

// ============= SECURITY ANALYSIS TYPES =============

export type SecuritySeverity = "critical" | "high" | "medium" | "low";

export type OWASPCategory =
  | "A01:2021-Broken Access Control"
  | "A02:2021-Cryptographic Failures"
  | "A03:2021-Injection"
  | "A04:2021-Insecure Design"
  | "A05:2021-Security Misconfiguration"
  | "A06:2021-Vulnerable Components"
  | "A07:2021-Auth Failures"
  | "A08:2021-Software Integrity"
  | "A09:2021-Logging Failures"
  | "A10:2021-SSRF";

export type SecurityVulnerability = {
  id: number;
  title: string;
  severity: SecuritySeverity;
  owasp?: OWASPCategory;
  status: "needs-fix" | "review" | "acceptable";
  location?: { file: string; line?: number; snippet?: string };
  issue: string;
  risk: string[];
  solution: string[];
  notes?: string;
};

export type PositiveSecurityPractice = {
  title: string;
  description: string;
  location?: { file: string; line?: number };
};

export type SecurityMetrics = {
  totalFilesAnalyzed: number;
  securityRelatedFiles: number;
  errorBoundaries: number;
  secureStorageOps: number;
  totalPatternsDetected: number;
  antiPatternsFound: number;
};

export type SecurityAnalysisArgs = {
  path: string;
  include?: string[];
  exclude?: string[];
  focus?: ("secrets" | "injection" | "xss" | "auth" | "crypto" | "config" | "mobile")[];
  severity?: SecuritySeverity;
};

export type SecurityAnalysisResponse = {
  vulnerabilities: SecurityVulnerability[];
  positivePractices: PositiveSecurityPractice[];
  metrics: SecurityMetrics;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  recommendations: {
    priority: "immediate" | "high" | "medium" | "ongoing";
    description: string;
  }[];
};
