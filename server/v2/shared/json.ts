export type JsonObject = Record<string, unknown>

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

export function requireString(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`)
  const result = value.trim()
  if (!result || result.length > maximum) throw new TypeError(`${name} must contain between 1 and ${maximum} characters`)
  return result
}

export function optionalString(value: unknown, name: string, maximum = 10_000): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, name, maximum)
}
