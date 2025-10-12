/**
 * Standardized response utilities for MCP tool handlers.
 * Ensures consistent error and success response formats across all handlers.
 */

/**
 * Standard MCP response content type.
 */
export interface MCPResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
}

/**
 * Creates a standardized success response with JSON content.
 */
export function successResponse(data: unknown): MCPResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  };
}

/**
 * Creates a standardized error response for unknown session IDs.
 */
export function unknownSessionError(sessionId: string): MCPResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: `Unknown session: ${sessionId}` }, null, 2) }]
  };
}

/**
 * Creates a standardized error response for validation failures.
 */
export function validationErrorResponse(message: string, details?: unknown): MCPResponse {
  const errorObj: Record<string, unknown> = { error: message };
  if (details !== undefined) {
    errorObj.details = details;
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify(errorObj, null, 2)
    }]
  };
}

/**
 * Creates a standardized error response for generic errors.
 */
export function errorResponse(error: unknown): MCPResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }]
  };
}

/**
 * Creates a standardized error response for runtime errors with stack trace.
 */
export function runtimeErrorResponse(error: Error, context?: string): MCPResponse {
  const errorObj: Record<string, unknown> = { error: error.message };
  if (context !== undefined) {
    errorObj.context = context;
  }
  if (error.stack !== undefined) {
    errorObj.stack = error.stack;
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify(errorObj, null, 2)
    }]
  };
}
