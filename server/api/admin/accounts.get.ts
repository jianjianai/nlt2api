import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const url = new URL(event.req.url);
    const rawPage = url.searchParams.get("page") ?? "1";
    const rawPageSize = url.searchParams.get("pageSize") ?? "20";
    const page = Number(rawPage);
    const pageSize = Number(rawPageSize);
    if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "`page` must be a positive integer.", "invalid_request_error", "page");
    if (pageSize !== 20 && pageSize !== 50 && pageSize !== 100) throw new HttpError(400, "`pageSize` must be 20, 50, or 100.", "invalid_request_error", "pageSize");
    const query = url.searchParams.get("query")?.trim() || undefined;
    const rawGroupId = url.searchParams.get("groupId");
    let groupId: string | null | undefined;
    if (rawGroupId === "ungrouped") groupId = null;
    else if (rawGroupId) {
      if (!await stateStore.getAccountGroup(rawGroupId)) throw new HttpError(400, "Account group not found.", "invalid_request_error", "groupId");
      groupId = rawGroupId;
    }
    const status = url.searchParams.get("status") || "all";
    if (status !== "all" && status !== "enabled" && status !== "disabled") throw new HttpError(400, "`status` is invalid.", "invalid_request_error", "status");
    const sort = url.searchParams.get("sort") || "created_desc";
    if (sort !== "created_desc" && sort !== "created_asc" && sort !== "label_asc" && sort !== "label_desc") throw new HttpError(400, "`sort` is invalid.", "invalid_request_error", "sort");
    const result = await stateStore.listAccountsPage({ page, pageSize, query, groupId, status, sort });
    return jsonResponse({
      accounts: result.accounts.map((account) => accountScheduler.publicState(account)),
      pagination: { page: result.page, pageSize: result.pageSize, total: result.total, pageCount: result.pageCount },
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
