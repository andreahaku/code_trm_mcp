/**
 * Constants for the TRM MCP server.
 */

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
export const MAX_CANDIDATE_FILES = 100; // Maximum files in a single candidate
export const MAX_RATIONALE_LENGTH = 4000; // Maximum length for rationale notes
export const SCORE_IMPROVEMENT_EPSILON = 1e-6; // Minimum improvement threshold
export const MAX_HINT_LINES = 12; // Maximum feedback hint lines
export const MAX_FEEDBACK_ITEMS = 16; // Maximum feedback items in response
export const MAX_FILE_READ_PATHS = 50; // Maximum file paths in single getFileContent request
export const MAX_RESPONSE_TOKENS = 20000; // Maximum tokens in MCP response (leave buffer below 25K limit)
export const AUTO_PAGINATION_LINE_THRESHOLD = 1000; // Auto-paginate files exceeding this line count
export const AUTO_PAGINATION_CHUNK_SIZE = 800; // Lines per chunk in auto-pagination (~8-10K tokens)
