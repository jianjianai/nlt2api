import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeepInfraModels } from "../server/utils/deepinfra-client.ts";

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
