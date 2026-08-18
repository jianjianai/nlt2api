import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const validator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strictSchema: true,
  strictNumbers: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  validateFormats: false,
});
const compiledSchemas = new Map<string, ValidateFunction | string>();
const MAX_COMPILED_SCHEMAS = 500;

function errorText(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const path = error.instancePath || "$";
    return `${path}: ${error.message ?? error.keyword} [${error.keyword}]`;
  });
}

function compileSchema(schema: JsonObject): ValidateFunction | string {
  const key = JSON.stringify(schema);
  const cached = compiledSchemas.get(key);
  if (cached) {
    return cached;
  }
  let compiled: ValidateFunction | string;
  try {
    compiled = validator.compile(schema);
  } catch (error) {
    validator.removeSchema(schema);
    compiled = error instanceof Error ? error.message : "Invalid JSON Schema.";
  }
  compiledSchemas.set(key, compiled);
  while (compiledSchemas.size > MAX_COMPILED_SCHEMAS) {
    const oldest = compiledSchemas.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = compiledSchemas.get(oldest);
    compiledSchemas.delete(oldest);
    if (typeof evicted !== "string" && evicted?.schema) {
      validator.removeSchema(evicted.schema);
    }
  }
  return compiled;
}

export function jsonSchemaCacheStats(): { compiledSchemas: number; ajvSchemas: number | null } {
  const internal = validator as unknown as { _cache?: Map<unknown, unknown> };
  return {
    compiledSchemas: compiledSchemas.size,
    ajvSchemas: internal._cache?.size ?? null,
  };
}

export function validateSchemaDefinition(schema: JsonObject): SchemaValidationResult {
  const compiled = compileSchema(schema);
  return typeof compiled === "string"
    ? { valid: false, errors: [compiled] }
    : { valid: true, errors: [] };
}

export function validateJsonSchema(value: unknown, schema: JsonObject | undefined): SchemaValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }
  const compiled = compileSchema(schema);
  if (typeof compiled === "string") {
    return { valid: false, errors: [`schema is invalid: ${compiled}`] };
  }
  const valid = compiled(value);
  return valid
    ? { valid: true, errors: [] }
    : { valid: false, errors: errorText(compiled.errors) };
}

export function parseAndValidateToolArguments(
  argumentsValue: string,
  schema: JsonObject | undefined,
): { value: JsonValue; validation: SchemaValidationResult } {
  let value: JsonValue;
  try {
    value = JSON.parse(argumentsValue) as JsonValue;
  } catch {
    return { value: null, validation: { valid: false, errors: ["arguments are not valid JSON"] } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, validation: { valid: false, errors: ["arguments must be a JSON object"] } };
  }
  return { value, validation: validateJsonSchema(value, schema) };
}
