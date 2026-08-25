import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeepInfraModels, deepInfraClient, deepInfraUpstreamError } from "../server/utils/deepinfra-client.ts";
import type { ManagedAccount } from "../server/utils/types.ts";

test("DeepInfra errors preserve model capacity and JSON retry metadata", () => {
  const capacity = deepInfraUpstreamError(429, JSON.stringify({ detail: "Model busy, retry later", retry_after: 7 }));
  assert.equal(capacity.kind, "model_capacity");
  assert.equal(capacity.retryAfterSeconds, 7);
  const limited = deepInfraUpstreamError(429, JSON.stringify({ error: { message: "Too many requests", retry_after: 31 } }));
  assert.equal(limited.kind, "rate_limit");
  assert.equal(limited.retryAfterSeconds, 31);
});

test("account verification delegates to the complete proxy probe facade", async () => {
  const original = deepInfraClient.probeProxy;
  const calls: Array<[string | undefined, AbortSignal | undefined]> = [];
  deepInfraClient.probeProxy = async (proxy, signal) => { calls.push([proxy, signal]); };
  const account = {
    id: "account",
    label: "Account",
    enabled: true,
    weight: 1,
    proxy: "socks5h://proxy.example:1080",
    groupIds: [],
    models: ["moonshotai/Kimi-K3"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies ManagedAccount;
  try {
    await deepInfraClient.verifyAccount(account);
    assert.deepEqual(calls.map(([proxy]) => proxy), [account.proxy]);
  } finally {
    deepInfraClient.probeProxy = original;
  }
});

test("anonymous model discovery requires featured and excludes no-free-anon", async () => {
  const models = classifyDeepInfraModels([
    {
      model_name: "moonshotai/Kimi-K3",
      reported_type: "text-generation",
      tags: ["openai", "featured"],
      max_tokens: 1_048_576,
    },
    {
      model_name: "anthropic/claude-sonnet-4-6",
      reported_type: "text-generation",
      tags: ["openai", "featured", "no-free-anon"],
      max_tokens: 1_000_000,
    },
    {
      model_name: "deepseek-ai/DeepSeek-R1-0528",
      reported_type: "text-generation",
      tags: ["openai"],
      max_tokens: 163_840,
    },
  ]);
  assert.deepEqual(models.map((model) => [model.id, model.freeForAnonymous]), [
    ["moonshotai/Kimi-K3", true],
    ["anthropic/claude-sonnet-4-6", false],
    ["deepseek-ai/DeepSeek-R1-0528", false],
  ]);
});
