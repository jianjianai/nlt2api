import { setResponseStatus, type H3Event } from "h3"

export type ApiErrorType = "invalid_request_error" | "authentication_error" | "rate_limit_error" | "server_error"

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly param?: string
  readonly type: ApiErrorType

  constructor(
    message: string,
    statusCode = 500,
    code = "internal_error",
    param?: string,
    type: ApiErrorType = statusCode === 401 ? "authentication_error" : "server_error"
  ) {
    super(message)
    this.name = "AppError"
    this.statusCode = statusCode
    this.code = code
    this.param = param
    this.type = type
  }
}

export class AccountAuthError extends AppError {
  readonly isAccountAuthError = true

  constructor(message: string, code = "account_authentication_failed") {
    super(message, 401, code, undefined, "authentication_error")
    this.name = "AccountAuthError"
  }
}

function asAppError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) {
    return error
  }

  return new AppError(fallbackMessage)
}

export function sendOpenAIError(event: H3Event, error: unknown) {
  const appError = asAppError(error, "The proxy could not complete the request")
  setResponseStatus(event, appError.statusCode)

  return {
    error: {
      message: appError.message,
      type: appError.type,
      param: appError.param ?? null,
      code: appError.code
    }
  }
}

export function sendManagementError(event: H3Event, error: unknown) {
  const appError = asAppError(error, "The management request failed")
  setResponseStatus(event, appError.statusCode)

  return {
    error: appError.message,
    code: appError.code
  }
}
