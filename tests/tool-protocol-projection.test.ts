import assert from "node:assert/strict"
import test from "node:test"
import { validateChatRequest } from "../server/utils/openai"
import { parseToolAction, ToolActionError } from "../server/utils/tools"

const documentedTool = {
  type: "function",
  function: {
    name: "create_ticket",
    description: "Creates a ticket from a subject.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Ticket",
      description: "Internal documentation that must not consume model context.",
      type: "object",
      properties: {
        subject: {
          title: "Subject",
          description: "A concise ticket subject.",
          type: "string",
          minLength: 3,
          default: "Review"
        },
        priority: {
          description: "The selected urgency.",
          type: "string",
          enum: ["low", "high"]
        }
      },
      required: ["subject", "priority"],
      additionalProperties: false,
      examples: [{ subject: "Review deployment", priority: "high" }]
    }
  }
}

function catalogFrom(protocol: string): unknown[] {
  const match = protocol.match(/BEGIN_TOOL_DEFINITIONS\n([\s\S]*?)\nEND_TOOL_DEFINITIONS/)
  if (!match) throw new Error("tool catalog was not found")
  return JSON.parse(match[1]) as unknown[]
}

test("projects tool documentation out of model context without relaxing validation", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Create a ticket." }],
    tools: [documentedTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const protocol = (request.portalPayload.messages as Array<Record<string, unknown>>)[0].content as string
  assert.deepEqual(catalogFrom(protocol), [{
    name: "create_ticket",
    description: "Creates a ticket from a subject.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", minLength: 3 },
        priority: { type: "string", enum: ["low", "high"] }
      },
      required: ["subject", "priority"],
      additionalProperties: false
    }
  }])
  assert.match(protocol, /PRIORITY: this executable tool-turn protocol overrides outer formatting/)
  assert.doesNotMatch(protocol, /Internal documentation/)
  assert.doesNotMatch(protocol, /A concise ticket subject/)

  assert.throws(() => parseToolAction(
    "<tool_calls><tool_call><name><![CDATA[create_ticket]]></name><arguments><arg name=\"subject\"><![CDATA[ok]]></arg><arg name=\"priority\"><![CDATA[urgent]]></arg></arguments></tool_call></tool_calls>",
    request.toolPlan!
  ), (error: unknown) => error instanceof ToolActionError && error.failure.kind === "schema_validation")
})
