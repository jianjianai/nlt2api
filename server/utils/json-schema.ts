import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const validatorOptions = {
  allErrors: true,
  allowUnionTypes: true,
  strictSchema: true,
  strictNumbers: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  validateFormats: false,
} as const;
const draft7Validator = new Ajv(validatorOptions);
const draft2020Validator = new Ajv2020(validatorOptions);
type SchemaValidator = typeof draft7Validator | typeof draft2020Validator;
interface CompiledSchema {
  result: ValidateFunction | string;
  validator: SchemaValidator;
}
const compiledSchemas = new Map<string, CompiledSchema>();
const MAX_COMPILED_SCHEMAS = 500;

function errorText(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const path = error.instancePath || "$";
    return `${path}: ${error.message ?? error.keyword} [${error.keyword}]`;
  });
}

function validatorFor(schema: JsonObject): SchemaValidator {
  const dialect = schema.$schema;
  return typeof dialect === "string" && dialect.includes("2020-12")
    ? draft2020Validator
    : draft7Validator;
}

function compileSchema(schema: JsonObject): ValidateFunction | string {
  const key = JSON.stringify(schema);
  const cached = compiledSchemas.get(key);
  if (cached) {
    return cached.result;
  }
  const validator = validatorFor(schema);
  let compiled: ValidateFunction | string;
  try {
    compiled = validator.compile(schema);
  } catch (error) {
    validator.removeSchema(schema);
    compiled = error instanceof Error ? error.message : "Invalid JSON Schema.";
  }
  compiledSchemas.set(key, { result: compiled, validator });
  while (compiledSchemas.size > MAX_COMPILED_SCHEMAS) {
    const oldest = compiledSchemas.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = compiledSchemas.get(oldest);
    compiledSchemas.delete(oldest);
    if (evicted && typeof evicted.result !== "string" && evicted.result.schema) {
      evicted.validator.removeSchema(evicted.result.schema);
    }
  }
  return compiled;
}

export function jsonSchemaCacheStats(): { compiledSchemas: number; ajvSchemas: number | null } {
  const draft7 = draft7Validator as unknown as { _cache?: Map<unknown, unknown> };
  const draft2020 = draft2020Validator as unknown as { _cache?: Map<unknown, unknown> };
  const cacheSizes = [draft7._cache?.size, draft2020._cache?.size];
  return {
    compiledSchemas: compiledSchemas.size,
    ajvSchemas: cacheSizes.every((size) => typeof size === "number")
      ? cacheSizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
      : null,
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

export interface LocatedSchemaError {
  instancePath: string;
  message: string;
  keyword: string;
}

export interface LocatedSchemaValidationResult {
  valid: boolean;
  errors: LocatedSchemaError[];
}

export function validateJsonSchemaLocated(value: unknown, schema: JsonObject | undefined): LocatedSchemaValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }
  const compiled = compileSchema(schema);
  if (typeof compiled === "string") {
    return { valid: false, errors: [{ instancePath: "$", message: `schema is invalid: ${compiled}`, keyword: "schema" }] };
  }
  const valid = compiled(value);
  return valid
    ? { valid: true, errors: [] }
    : {
      valid: false,
      errors: (compiled.errors ?? []).map((error) => ({
        instancePath: error.instancePath || "$",
        message: error.message ?? error.keyword,
        keyword: error.keyword,
      })),
    };
}

export function parseAndValidateToolArgumentsLocated(
  argumentsValue: string,
  schema: JsonObject | undefined,
): { value: JsonValue; validation: LocatedSchemaValidationResult } {
  let value: JsonValue;
  try {
    value = JSON.parse(argumentsValue) as JsonValue;
  } catch {
    return { value: null, validation: { valid: false, errors: [{ instancePath: "$", message: "arguments are not valid JSON", keyword: "parse" }] } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, validation: { valid: false, errors: [{ instancePath: "$", message: "arguments must be a JSON object", keyword: "type" }] } };
  }
  return { value, validation: validateJsonSchemaLocated(value, schema) };
}
