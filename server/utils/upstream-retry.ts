export const MAX_UPSTREAM_CHAT_ATTEMPTS = 3;

export function retryableUpstreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

export function retryableUpstreamError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return true;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status !== "number" || retryableUpstreamStatus(status);
}

export function upstreamRetryDelayMs(attempt: number): number {
  return Math.min(2_000, 100 * (2 ** Math.max(0, attempt - 1)));
}
