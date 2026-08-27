import { defineHandler } from "nitro";
import { adminRoute, pagination } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import type { ErrorLogKind, ErrorLogStatus } from "~/server/utils/types.ts";

const KINDS: ErrorLogKind[] = ["minter", "forward"];
const STATUSES: ErrorLogStatus[] = ["failed", "rejected"];

export default defineHandler((event) => adminRoute((request) => {
  const url = new URL(request.url);
  const rawKind = url.searchParams.get("kind");
  const kind = KINDS.find((candidate) => candidate === rawKind);
  const rawStatus = url.searchParams.get("status");
  const status = STATUSES.find((candidate) => candidate === rawStatus);
  const sessionId = url.searchParams.get("sessionId")?.slice(0, 200) || undefined;
  const { limit, offset } = pagination(request);
  const runtime = gatewayRuntime();
  const { entries, total } = runtime.errors.list({
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(sessionId ? { sessionId } : {}),
    limit,
    offset,
  });
  return jsonResponse({ entries, total, limit, offset, summary: runtime.errors.summary() });
})(event.req));