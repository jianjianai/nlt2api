export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error"

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly type: OpenAIErrorType
  readonly param?: string
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    options: {
      status: number
      code: string
      type?: OpenAIErrorType
      param?: string
      retryAfterSeconds?: number
      cause?: unknown
    }
  ) {
    super(message, { cause: options.cause })
    this.name = "ApiError"
    this.status = options.status
    this.code = options.code
    this.type = options.type ?? errorTypeForStatus(options.status)
    this.param = options.param
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export function errorTypeForStatus(status: number): OpenAIErrorType {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 400 && status < 500) return "invalid_request_error"
  return "server_error"
}

export function invalidRequest(message: string, code: string, param?: string): ApiError {
  return new ApiError(message, { status: 400, code, param, type: "invalid_request_error" })
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError("The server could not complete the request", {
    status: 500,
    code: "internal_error",
    cause: error
  })
}

export function openAIErrorBody(error: ApiError): Record<string, unknown> {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param ?? null,
      code: error.code
    }
  }
}
