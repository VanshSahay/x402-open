/**
 * Shared error formatting for adapter error responses.
 */
export interface FormattedError {
  error: string;
  message: string;
}

/**
 * Formats an unknown error into a consistent structure for HTTP responses.
 */
export function formatError(error: unknown): FormattedError {
  return {
    error: "Internal server error",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
