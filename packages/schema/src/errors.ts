export type PlumbErrorCode =
  | "NO_API_KEY"
  | "NO_INSTRUCTION_FILES"
  | "RUBRIC_INVALID"
  | "RUBRIC_MISSING"
  | "SETTINGS_INVALID"
  | "HOST_UNKNOWN"
  | "HOST_NOT_FOUND"
  | "GIT_UNAVAILABLE"
  | "CLAUDE_UNAVAILABLE"
  | "CHECK_TIMEOUT"
  | "CHECK_FAILED";

export class PlumbError extends Error {
  readonly code: PlumbErrorCode;

  constructor(code: PlumbErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlumbError";
    this.code = code;
  }
}

export const isPlumbError = (value: unknown): value is PlumbError => value instanceof PlumbError;
