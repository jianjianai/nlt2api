import type { ManagedAccount } from "~/server/utils/types.ts";

/** Public OpenAI model id: hide DeepInfra's catalog owner prefix. */
export function publicModelId(upstreamId: string): string {
  const separator = upstreamId.lastIndexOf("/");
  return separator >= 0 ? upstreamId.slice(separator + 1) : upstreamId;
}

/** Accept both the public short id and the full DeepInfra catalog id. */
export function modelIdMatches(upstreamId: string, requestedId: string): boolean {
  return upstreamId === requestedId || publicModelId(upstreamId) === requestedId;
}

/** Resolve one client model id to the full id supported by a scheduled account. */
export function upstreamModelId(account: ManagedAccount, requestedId: string): string | undefined {
  const exact = account.models.find((model) => model === requestedId);
  if (exact) return exact;
  const matches = account.models.filter((model) => publicModelId(model) === requestedId);
  return matches.length === 1 ? matches[0] : undefined;
}
