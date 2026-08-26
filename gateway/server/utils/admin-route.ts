import { toHttpError } from "~/server/utils/error-mapping.ts";
import { openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";

export { toHttpError as adminHttpError };

/** Wraps an admin handler with authentication and uniform error mapping. */
export function adminRoute<T>(handler: (request: Request) => T | Promise<T>): (request: Request) => Promise<Response | T> {
  return async (request: Request) => {
    try {
      requireAdminAuth(request);
      return await handler(request);
    } catch (error) {
      return openAIErrorResponse(toHttpError(error));
    }
  };
}

export function pagination(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const rawSize = Number(url.searchParams.get("pageSize") ?? "50") || 50;
  const limit = [20, 50, 100, 200].includes(rawSize) ? rawSize : 50;
  return { limit, offset: (page - 1) * limit };
}
