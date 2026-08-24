import type { GroupApiKey } from "~/server/utils/types.ts";
import { HttpError } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export interface PublicGroupApiKey {
  id: string;
  groupId: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function publicGroupApiKey(key: GroupApiKey): PublicGroupApiKey {
  return {
    id: key.id,
    groupId: key.groupId,
    name: key.name,
    prefix: key.prefix,
    enabled: key.enabled,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

export function accountGroupAdminError(error: unknown): HttpError {
  if (error instanceof Error && error.message.includes("already exists")) {
    return new HttpError(409, error.message, "invalid_request_error");
  }
  return adminHttpError(error);
}
