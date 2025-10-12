/**
 * Constants for the TRM MCP server.
 */

// File and request limits
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
export const MAX_CANDIDATE_FILES = 100; // Maximum files in a single candidate
export const MAX_RATIONALE_LENGTH = 4000; // Maximum length for rationale notes
export const MAX_HINT_LINES = 12; // Maximum feedback hint lines
export const MAX_FEEDBACK_ITEMS = 16; // Maximum feedback items in response
export const MAX_FILE_READ_PATHS = 50; // Maximum file paths in single getFileContent request
export const MAX_RESPONSE_TOKENS = 20000; // Maximum tokens in MCP response (leave buffer below 25K limit)
export const AUTO_PAGINATION_LINE_THRESHOLD = 1000; // Auto-paginate files exceeding this line count
export const AUTO_PAGINATION_CHUNK_SIZE = 800; // Lines per chunk in auto-pagination (~8-10K tokens)

// Default configuration values
export const DEFAULT_TIMEOUT_SEC = 120; // Default command timeout in seconds
export const DEFAULT_LINT_TIMEOUT_MIN_SEC = 30; // Minimum lint timeout in seconds
export const DEFAULT_WEIGHT_BUILD = 0.3; // Default weight for build signal
export const DEFAULT_WEIGHT_TEST = 0.5; // Default weight for test signal
export const DEFAULT_WEIGHT_LINT = 0.1; // Default weight for lint signal
export const DEFAULT_WEIGHT_PERF = 0.1; // Default weight for performance signal
export const DEFAULT_MIN_STEPS = 1; // Default minimum steps before halting
export const DEFAULT_EMA_ALPHA = 0.9; // Default EMA smoothing factor (0-1)

// Scoring and evaluation
export const SCORE_IMPROVEMENT_EPSILON = 1e-6; // Minimum improvement threshold
export const LINT_TIMEOUT_DIVISOR = 2; // Divisor for calculating lint timeout from main timeout
export const FIRST_STEP = 1; // Step number for first iteration (used in EMA initialization)
