import assert from "node:assert/strict";
import test from "node:test";
import { openAIErrorResponse } from "../server/utils/http.ts";
import { upstreamHttpError } from "../server/utils/route-helpers.ts";
import { UpstreamError } from "../server/utils/upstream-http.ts";

test("upstream error mapping distinguishes challenge, model capacity and egress rate limits", async () => {
  const challenge = openAIErrorResponse(upstreamHttpError(new UpstreamError("no ticket", 503, undefined, undefined, "challenge")));
  assert.equal(challenge.status, 503);
  assert.equal((await challenge.json()).error.code, "challenge_unavailable");

  const capacity = openAIErrorResponse(upstreamHttpError(new UpstreamError("Model busy", 429, 3, undefined, "model_capacity")));
  assert.equal(capacity.status, 429);
  assert.equal(capacity.headers.get("retry-after"), "3");
  assert.equal((await capacity.json()).error.code, "model_capacity");

  const limited = openAIErrorResponse(upstreamHttpError(new UpstreamError("Too many requests", 429, 27, undefined, "rate_limit")));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "27");
  assert.equal((await limited.json()).error.code, "rate_limit_exceeded");
});
