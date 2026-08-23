import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

function retentionDays(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 36_500) return value;
  throw new HttpError(400, `\`${field}\` must be null or an integer from 1 through 36500.`, "invalid_request_error", field);
}

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const unknown = Object.keys(body).find((field) => !["executionDays", "minuteDays"].includes(field));
    if (unknown) throw new HttpError(400, `Unknown retention field \`${unknown}\`.`, "invalid_request_error", unknown);
    return jsonResponse({
      retention: usageAnalytics.updateRetention({
        executionDays: retentionDays(body.executionDays, "executionDays"),
        minuteDays: retentionDays(body.minuteDays, "minuteDays"),
      }),
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
