import type { SessionId, SessionState } from "../types.js";

/**
 * Global session storage.
 * Shared across all tool handlers.
 */
export const sessions = new Map<SessionId, SessionState>();
