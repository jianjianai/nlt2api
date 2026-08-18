import { isIP } from "node:net"
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019.js"
import Ajv2020 from "ajv/dist/2020.js"
import draft6MetaSchema from "ajv/dist/refs/json-schema-draft-06.json"
import { invalidRequest } from "../shared/errors"
import { cloneJson, hasOwn, isJsonObject, type JsonObject } from "../shared/json"
import { MAX_TOOL_COUNT, MAX_TOOL_SCHEMA_BYTES } from "../shared/limits"

export type ChatRole = "system" | "user" | "assistant" | "tool" | "function"
export type ResponseFormat = "text" | "json_object"
export type ToolChoiceMode = "auto" | "none" | "required" | "named"

export interface NormalizedToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ChatMessage = JsonObject & {
  role: ChatRole
  content?: unknown
  tool_calls?: NormalizedToolCall[]
  tool_call_id?: string
}

export interface FunctionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: JsonObject
    strict?: boolean
  }
  validate: ValidateFunction
}

export interface FunctionToolPlan {
  tools: FunctionTool[]
  choice: ToolChoiceMode
  namedTool?: string
  parallel: boolean
}

export interface ParsedChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream: boolean
  includeUsage: boolean
  includeObfuscation: boolean
  responseFormat: ResponseFormat
  maxTokens?: number
  temperature?: number
  topP?: number
  toolPlan?: FunctionToolPlan
  ignoredFields: string[]
  portalPayload: JsonObject
}

const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/
const messageNamePattern = /^[A-Za-z0-9_-]{1,64}$/

const ignoredFields = new Set([
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "store",
  "metadata",
  "service_tier",
  "verbosity",
  "safety_identifier",
  "user"
])

const supportedFields = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "modalities",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "n",
  ...ignoredFields
])

const explicitlyUnsupportedFields = new Set([
  "stop",
  "seed",
  "functions",
  "function_call",
  "logprobs",
  "top_logprobs",
  "audio",
  "prediction",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "web_search_options"
])

function byteLength(value: unknown, param: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    throw invalidRequest(`${param} must be JSON serializable`, "invalid_parameter", param)
  }
}

function assertKnownKeys(value: JsonObject, allowed: ReadonlySet<string>, param: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidRequest(`${param}.${key} is not supported`, "unsupported_parameter", `${param}.${key}`)
    }
  }
}

function requireNonEmptyString(value: unknown, param: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw invalidRequest(`${param} must contain between 1 and ${maximum} characters`, "invalid_parameter", param)
  }
  return value
}

function optionalMessageName(value: unknown, param: string): string | undefined {
  if (value === undefined) return undefined
  const name = requireNonEmptyString(value, param, 64)
  if (!messageNamePattern.test(name)) {
    throw invalidRequest(`${param} contains unsupported characters`, "invalid_message", param)
  }
  return name
}

function requireFiniteNumber(value: unknown, param: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${param} must be a finite number between ${minimum} and ${maximum}`, "invalid_parameter", param)
  }
  return value
}

function requirePositiveInteger(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequest(`${param} must be a positive integer`, "invalid_parameter", param)
  }
  return value
}

function normalizeTextPart(raw: unknown, param: string): JsonObject {
  if (!isJsonObject(raw)) throw invalidRequest(`${param} must be an object`, "invalid_message", param)
  assertKnownKeys(raw, new Set(["type", "text"]), param)
  if (raw.type !== "text" || typeof raw.text !== "string") {
    throw invalidRequest(`${param} must be a text content part`, "unsupported_content_part", param)
  }
  return { type: "text", text: raw.text }
}

function normalizeImagePart(raw: JsonObject, param: string): JsonObject {
  assertKnownKeys(raw, new Set(["type", "image_url"]), param)
  if (!isJsonObject(raw.image_url)) {
    throw invalidRequest(`${param}.image_url must be an object`, "invalid_message", `${param}.image_url`)
  }
  assertKnownKeys(raw.image_url, new Set(["url", "detail"]), `${param}.image_url`)
  const url = requireNonEmptyString(raw.image_url.url, `${param}.image_url.url`, 2_000_000)
  const detail = raw.image_url.detail
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
    throw invalidRequest(`${param}.image_url.detail is invalid`, "invalid_message", `${param}.image_url.detail`)
  }
  return { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } }
}

function normalizeContent(
  value: unknown,
  param: string,
  options: { allowNull?: boolean; allowImage?: boolean }
): unknown {
  if (typeof value === "string") return value
  if (value === null && options.allowNull) return null
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest(`${param} must be a string or a non-empty content-part array`, "invalid_message", param)
  }
  return value.map((part, index) => {
    const partParam = `${param}[${index}]`
    if (isJsonObject(part) && part.type === "image_url" && options.allowImage) {
      return normalizeImagePart(part, partParam)
    }
    return normalizeTextPart(part, partParam)
  })
}

function normalizeToolCalls(value: unknown, param: string): NormalizedToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest(`${param} must be a non-empty array`, "invalid_message", param)
  }
  const ids = new Set<string>()
  return value.map((raw, index) => {
    const callParam = `${param}[${index}]`
    if (!isJsonObject(raw)) throw invalidRequest(`${callParam} must be an object`, "invalid_message", callParam)
    assertKnownKeys(raw, new Set(["id", "type", "function"]), callParam)
    const id = requireNonEmptyString(raw.id, `${callParam}.id`, 128)
    if (ids.has(id)) throw invalidRequest(`${param} contains duplicate id ${id}`, "invalid_message", `${callParam}.id`)
    ids.add(id)
    if (raw.type !== "function" || !isJsonObject(raw.function)) {
      throw invalidRequest(`${callParam} must be a function tool call`, "invalid_message", callParam)
    }
    assertKnownKeys(raw.function, new Set(["name", "arguments"]), `${callParam}.function`)
    const name = requireNonEmptyString(raw.function.name, `${callParam}.function.name`, 64)
    if (!toolNamePattern.test(name)) {
      throw invalidRequest(`${callParam}.function.name is invalid`, "invalid_message", `${callParam}.function.name`)
    }
    // Tool-call history belongs to the caller. OpenAI represents arguments as a
    // string and clients can legitimately retain a malformed candidate together
    // with its tool result. Validate the wire shape here, but reserve JSON and
    // schema validation for a newly generated agent action.
    if (typeof raw.function.arguments !== "string" || raw.function.arguments.length > MAX_TOOL_SCHEMA_BYTES) {
      throw invalidRequest(`${callParam}.function.arguments must be a string of at most ${MAX_TOOL_SCHEMA_BYTES} characters`, "invalid_message", `${callParam}.function.arguments`)
    }
    const args = raw.function.arguments
    return { id, type: "function", function: { name, arguments: args } }
  })
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("messages must be a non-empty array", "invalid_messages", "messages")
  }

  const messages: ChatMessage[] = []
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index]
    const param = `messages[${index}]`
    if (!isJsonObject(raw) || typeof raw.role !== "string") {
      throw invalidRequest(`${param} must contain a supported role`, "invalid_message", param)
    }

    if (raw.role === "system" || raw.role === "user") {
      assertKnownKeys(raw, new Set(["role", "content", "name"]), param)
      if (!hasOwn(raw, "content")) throw invalidRequest(`${param}.content is required`, "invalid_message", `${param}.content`)
      const name = optionalMessageName(raw.name, `${param}.name`)
      messages.push({
        role: raw.role,
        content: normalizeContent(raw.content, `${param}.content`, { allowImage: raw.role === "user" }),
        ...(name ? { name } : {})
      })
      continue
    }

    if (raw.role === "assistant") {
      assertKnownKeys(raw, new Set(["role", "content", "name", "tool_calls", "reasoning", "reasoning_content"]), param)
      const calls = hasOwn(raw, "tool_calls") ? normalizeToolCalls(raw.tool_calls, `${param}.tool_calls`) : undefined
      if (!hasOwn(raw, "content") && !calls) {
        throw invalidRequest(`${param}.content is required without tool_calls`, "invalid_message", `${param}.content`)
      }
      const content = hasOwn(raw, "content")
        ? normalizeContent(raw.content, `${param}.content`, { allowNull: true })
        : null
      if (content === null && !calls) {
        throw invalidRequest(`${param}.content may be null only when tool_calls are present`, "invalid_message", `${param}.content`)
      }
      const name = optionalMessageName(raw.name, `${param}.name`)
      const reasoningValue = raw.reasoning_content ?? raw.reasoning
      if (reasoningValue !== undefined && reasoningValue !== null && typeof reasoningValue !== "string") {
        throw invalidRequest(`${param}.reasoning_content must be a string or null`, "invalid_message", `${param}.reasoning_content`)
      }
      messages.push({
        role: "assistant",
        content,
        ...(name ? { name } : {}),
        ...(reasoningValue !== undefined ? { reasoning: reasoningValue } : {}),
        ...(calls ? { tool_calls: calls } : {})
      })
      continue
    }

    if (raw.role === "tool") {
      assertKnownKeys(raw, new Set(["role", "content", "tool_call_id"]), param)
      if (!hasOwn(raw, "content")) throw invalidRequest(`${param}.content is required`, "invalid_message", `${param}.content`)
      const toolCallId = requireNonEmptyString(raw.tool_call_id, `${param}.tool_call_id`, 128)
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: normalizeContent(raw.content, `${param}.content`, {})
      })
      continue
    }

    if (raw.role === "function") {
      assertKnownKeys(raw, new Set(["role", "content", "name"]), param)
      const name = optionalMessageName(raw.name, `${param}.name`)
      if (!name) throw invalidRequest(`${param}.name is required`, "invalid_message", `${param}.name`)
      if (!hasOwn(raw, "content")) throw invalidRequest(`${param}.content is required`, "invalid_message", `${param}.content`)
      messages.push({ role: "function", name, content: normalizeContent(raw.content, `${param}.content`, { allowNull: true }) })
      continue
    }

    throw invalidRequest(`The ${raw.role} message role is unsupported`, "unsupported_role", `${param}.role`)
  }

  validateToolTransactions(messages)
  return messages
}

function validateToolTransactions(messages: ChatMessage[]): void {
  let expected: Map<string, number> | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === "tool") {
      if (!expected) {
        throw invalidRequest(`messages[${index}] is not preceded by assistant tool_calls`, "invalid_tool_history", `messages[${index}]`)
      }
      const id = message.tool_call_id as string
      if (!expected.has(id)) {
        throw invalidRequest(`messages[${index}].tool_call_id does not match the pending transaction`, "invalid_tool_history", `messages[${index}].tool_call_id`)
      }
      expected.delete(id)
      if (expected.size === 0) expected = undefined
      continue
    }

    if (expected) {
      const firstMissing = expected.keys().next().value as string
      throw invalidRequest(`Tool result ${firstMissing} must immediately follow its assistant tool_calls`, "invalid_tool_history", `messages[${index}]`)
    }

    if (message.role === "assistant" && message.tool_calls) {
      expected = new Map(message.tool_calls.map((call) => [call.id, index]))
    }
  }

  if (expected) {
    const firstMissing = expected.keys().next().value as string
    throw invalidRequest(`Tool result ${firstMissing} is missing`, "invalid_tool_history", "messages")
  }
}

type AjvCompiler = { compile(schema: JsonObject): ValidateFunction; addFormat(name: string, format: RegExp | ((value: string) => boolean)): unknown }

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
}

function validUri(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol)
  } catch {
    return false
  }
}

function addStandardFormats(compiler: AjvCompiler): void {
  compiler.addFormat("date", validDate)
  compiler.addFormat("time", validTime)
  compiler.addFormat("date-time", (value) => {
    const separator = value.search(/[Tt]/)
    return separator > 0 && validDate(value.slice(0, separator)) && validTime(value.slice(separator + 1))
  })
  compiler.addFormat("duration", /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/)
  compiler.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  compiler.addFormat("hostname", (value) => value.length <= 253 && value.split(".").every((part) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(part)))
  compiler.addFormat("ipv4", (value) => isIP(value) === 4)
  compiler.addFormat("ipv6", (value) => isIP(value) === 6)
  compiler.addFormat("uri", validUri)
  compiler.addFormat("uri-reference", (value) => {
    try {
      void new URL(value, "https://schema.invalid/")
      return true
    } catch {
      return false
    }
  })
  compiler.addFormat("uri-template", () => true)
  compiler.addFormat("url", validUri)
  compiler.addFormat("uuid", /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  compiler.addFormat("regex", (value) => {
    try {
      void new RegExp(value, "u")
      return true
    } catch {
      return false
    }
  })
  compiler.addFormat("json-pointer", /^(?:\/(?:[^~/]|~[01])*)*$/)
  compiler.addFormat("relative-json-pointer", /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/)
}

function draft7Compiler(): AjvCompiler {
  const compiler = new Ajv({ allErrors: true, strict: false, validateFormats: true })
  compiler.addMetaSchema(draft6MetaSchema)
  addStandardFormats(compiler)
  return compiler
}

function draft2019Compiler(): AjvCompiler {
  const compiler = new Ajv2019({ allErrors: true, strict: false, validateFormats: true })
  addStandardFormats(compiler)
  return compiler
}

function draft2020Compiler(): AjvCompiler {
  const compiler = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
  addStandardFormats(compiler)
  return compiler
}

function schemaCompiler(parameters: JsonObject, param: string): AjvCompiler {
  const dialect = parameters.$schema
  if (dialect === undefined) return draft7Compiler()
  if (typeof dialect !== "string") {
    throw invalidRequest(`${param}.$schema must be a string`, "invalid_tool_schema", `${param}.$schema`)
  }
  const normalized = dialect.toLowerCase()
  if (normalized.includes("draft-06") || normalized.includes("draft/06") || normalized.includes("draft-07") || normalized.includes("draft/07")) return draft7Compiler()
  if (normalized.includes("draft/2019-09") || normalized.includes("draft-2019-09")) return draft2019Compiler()
  if (normalized.includes("draft/2020-12") || normalized.includes("draft-2020-12")) return draft2020Compiler()
  throw invalidRequest(`${param} declares an unsupported JSON Schema dialect`, "unsupported_tool_schema_dialect", `${param}.$schema`)
}

function compileToolSchema(parameters: JsonObject, param: string): ValidateFunction {
  // Ajv registers a schema's $id on the compiler instance. Never reuse that
  // registry across tools or requests: callers may independently use the same
  // perfectly valid $id (including IDs used by local $ref values).
  const schema = cloneJson(parameters)
  try {
    return schemaCompiler(schema, param).compile(schema)
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error
    throw invalidRequest(`${param} is not a valid JSON Schema: ${error instanceof Error ? error.message : "unknown schema error"}`, "invalid_tool_schema", param)
  }
}

function normalizeTools(value: unknown): FunctionTool[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("tools must be a non-empty array", "invalid_parameter", "tools")
  }
  if (value.length > MAX_TOOL_COUNT) {
    throw invalidRequest(`tools may contain at most ${MAX_TOOL_COUNT} entries`, "tool_limit_exceeded", "tools")
  }
  if (byteLength(value, "tools") > MAX_TOOL_SCHEMA_BYTES) {
    throw invalidRequest(`tools may contain at most ${MAX_TOOL_SCHEMA_BYTES} UTF-8 bytes`, "tool_schema_limit_exceeded", "tools")
  }

  const names = new Set<string>()
  return value.map((raw, index) => {
    const param = `tools[${index}]`
    if (!isJsonObject(raw)) throw invalidRequest(`${param} must be an object`, "invalid_parameter", param)
    assertKnownKeys(raw, new Set(["type", "function"]), param)
    if (raw.type !== "function" || !isJsonObject(raw.function)) {
      throw invalidRequest(`${param} must be a function tool`, "unsupported_tool_type", param)
    }
    assertKnownKeys(raw.function, new Set(["name", "description", "parameters", "strict"]), `${param}.function`)
    const name = requireNonEmptyString(raw.function.name, `${param}.function.name`, 64)
    if (!toolNamePattern.test(name)) throw invalidRequest(`${param}.function.name is invalid`, "invalid_parameter", `${param}.function.name`)
    if (names.has(name)) throw invalidRequest(`Duplicate function tool name: ${name}`, "duplicate_tool", `${param}.function.name`)
    names.add(name)
    const description = raw.function.description
    if (description !== undefined && (typeof description !== "string" || description.length > 10_000)) {
      throw invalidRequest(`${param}.function.description must be a string of at most 10000 characters`, "invalid_parameter", `${param}.function.description`)
    }
    const parameters = raw.function.parameters === undefined
      ? { type: "object", properties: {} }
      : raw.function.parameters
    if (!isJsonObject(parameters)) {
      throw invalidRequest(`${param}.function.parameters must be an object`, "invalid_parameter", `${param}.function.parameters`)
    }
    if (raw.function.strict !== undefined && typeof raw.function.strict !== "boolean") {
      throw invalidRequest(`${param}.function.strict must be a boolean`, "invalid_parameter", `${param}.function.strict`)
    }
    const clonedParameters = cloneJson(parameters)
    return {
      type: "function",
      function: {
        name,
        ...(description !== undefined ? { description } : {}),
        parameters: clonedParameters,
        ...(typeof raw.function.strict === "boolean" ? { strict: raw.function.strict } : {})
      },
      validate: compileToolSchema(clonedParameters, `${param}.function.parameters`)
    }
  })
}

function namedChoice(value: JsonObject): string | undefined {
  if (isJsonObject(value.function)) return typeof value.function.name === "string" ? value.function.name : undefined
  return typeof value.name === "string" ? value.name : undefined
}

function normalizeToolPlan(input: JsonObject): FunctionToolPlan | undefined {
  if (!hasOwn(input, "tools")) {
    if (input.tool_choice !== undefined && input.tool_choice !== "none") {
      throw invalidRequest("tool_choice requires tools", "invalid_parameter", "tool_choice")
    }
    if (input.parallel_tool_calls !== undefined) {
      throw invalidRequest("parallel_tool_calls requires tools", "invalid_parameter", "parallel_tool_calls")
    }
    return undefined
  }

  const tools = normalizeTools(input.tools)
  const parallel = input.parallel_tool_calls === undefined ? true : input.parallel_tool_calls
  if (typeof parallel !== "boolean") {
    throw invalidRequest("parallel_tool_calls must be a boolean", "invalid_parameter", "parallel_tool_calls")
  }
  const choice = input.tool_choice
  if (choice === undefined || choice === "auto") return { tools, choice: "auto", parallel }
  if (choice === "none") return { tools, choice: "none", parallel }
  if (choice === "required") return { tools, choice: "required", parallel }
  if (!isJsonObject(choice) || choice.type !== "function") {
    throw invalidRequest("tool_choice must be auto, none, required, or a named function", "invalid_parameter", "tool_choice")
  }
  assertKnownKeys(choice, new Set(["type", "function", "name"]), "tool_choice")
  if (isJsonObject(choice.function)) {
    assertKnownKeys(choice.function, new Set(["name"]), "tool_choice.function")
  }
  const name = namedChoice(choice)
  if (!name || !tools.some((tool) => tool.function.name === name)) {
    throw invalidRequest("tool_choice references an unknown function", "invalid_parameter", "tool_choice")
  }
  return { tools, choice: "named", namedTool: name, parallel }
}

function normalizeResponseFormat(value: unknown): ResponseFormat {
  if (value === undefined) return "text"
  if (!isJsonObject(value)) throw invalidRequest("response_format must be an object", "invalid_parameter", "response_format")
  assertKnownKeys(value, new Set(["type"]), "response_format")
  if (value.type !== "text" && value.type !== "json_object") {
    throw invalidRequest("Only response_format text and json_object are supported", "unsupported_response_format", "response_format")
  }
  return value.type
}

export function toolValidationError(tool: FunctionTool): string | undefined {
  if (!tool.validate.errors?.length) return undefined
  return tool.validate.errors.slice(0, 8).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ")
}

export function parseChatCompletionRequest(input: unknown): ParsedChatCompletionRequest {
  if (!isJsonObject(input)) {
    throw invalidRequest("The request body must be a JSON object", "invalid_request", undefined)
  }
  for (const key of Object.keys(input)) {
    if (explicitlyUnsupportedFields.has(key)) {
      throw invalidRequest(`${key} is not supported`, "unsupported_parameter", key)
    }
    if (!supportedFields.has(key)) {
      throw invalidRequest(`${key} is not supported by this adapter`, "unsupported_parameter", key)
    }
  }

  const model = requireNonEmptyString(input.model, "model", 256).trim()
  const messages = normalizeMessages(input.messages)
  const stream = input.stream === undefined ? false : input.stream
  if (typeof stream !== "boolean") throw invalidRequest("stream must be a boolean", "invalid_parameter", "stream")

  if (hasOwn(input, "n")) {
    if (input.n !== 1) {
      if (typeof input.n === "number" && Number.isSafeInteger(input.n) && input.n > 1) {
        throw invalidRequest("n greater than 1 is not supported", "unsupported_parameter", "n")
      }
      throw invalidRequest("n must be the integer 1", "invalid_parameter", "n")
    }
  }

  const temperature = hasOwn(input, "temperature")
    ? requireFiniteNumber(input.temperature, "temperature", 0, 2)
    : undefined
  const topP = hasOwn(input, "top_p")
    ? requireFiniteNumber(input.top_p, "top_p", 0, 1)
    : undefined
  const explicitMaxTokens = hasOwn(input, "max_tokens")
    ? requirePositiveInteger(input.max_tokens, "max_tokens")
    : undefined
  const completionMaxTokens = hasOwn(input, "max_completion_tokens")
    ? requirePositiveInteger(input.max_completion_tokens, "max_completion_tokens")
    : undefined
  const maxTokens = explicitMaxTokens ?? completionMaxTokens
  const responseFormat = normalizeResponseFormat(input.response_format)
  const toolPlan = normalizeToolPlan(input)

  if (hasOwn(input, "modalities")) {
    if (!Array.isArray(input.modalities) || input.modalities.length !== 1 || input.modalities[0] !== "text") {
      throw invalidRequest("Only the text modality is supported", "unsupported_modality", "modalities")
    }
  }

  let includeUsage = false
  let includeObfuscation = false
  if (hasOwn(input, "stream_options")) {
    if (!stream) throw invalidRequest("stream_options requires stream: true", "invalid_parameter", "stream_options")
    if (!isJsonObject(input.stream_options)) {
      throw invalidRequest("stream_options must be an object", "invalid_parameter", "stream_options")
    }
    assertKnownKeys(input.stream_options, new Set(["include_usage", "include_obfuscation"]), "stream_options")
    if (hasOwn(input.stream_options, "include_usage")) {
      if (typeof input.stream_options.include_usage !== "boolean") {
        throw invalidRequest("stream_options.include_usage must be a boolean", "invalid_parameter", "stream_options.include_usage")
      }
      includeUsage = input.stream_options.include_usage
    }
    if (hasOwn(input.stream_options, "include_obfuscation")) {
      if (typeof input.stream_options.include_obfuscation !== "boolean") {
        throw invalidRequest("stream_options.include_obfuscation must be a boolean", "invalid_parameter", "stream_options.include_obfuscation")
      }
      includeObfuscation = input.stream_options.include_obfuscation
    }
  }

  const portalPayload: JsonObject = { model, messages: cloneJson(messages), stream }
  if (temperature !== undefined) portalPayload.temperature = temperature
  if (topP !== undefined) portalPayload.top_p = topP
  if (maxTokens !== undefined) portalPayload.max_tokens = maxTokens
  if (hasOwn(input, "modalities")) portalPayload.modalities = ["text"]
  if ((!toolPlan || toolPlan.choice === "none") && hasOwn(input, "response_format")) {
    portalPayload.response_format = { type: responseFormat }
  }

  return {
    model,
    messages,
    stream,
    includeUsage,
    includeObfuscation,
    responseFormat,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(toolPlan ? { toolPlan } : {}),
    ignoredFields: Object.keys(input).filter((key) => ignoredFields.has(key)),
    portalPayload
  }
}
