import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { ApiError, invalidRequest } from "../shared/errors"
import { cloneJson } from "../shared/json"
import type { StateRepository } from "../state/file-repository"
import {
  toPublicInferenceApiKey,
  type PublicInferenceApiKey,
  type StoredInferenceApiKey
} from "../state/schema"

export interface InferenceApiKeyServiceOptions {
  now?: () => number
  createId?: () => string
  createSecret?: () => string
}

export interface CreatedInferenceApiKey {
  apiKey: PublicInferenceApiKey
  secret: string
}

export interface UpdateInferenceApiKeyInput {
  label?: string
  enabled?: boolean
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest()
}

function keyNotFound(): ApiError {
  return new ApiError("Inference API key not found", { status: 404, code: "inference_api_key_not_found" })
}

function labelValue(value: unknown): string {
  if (typeof value !== "string") throw invalidRequest("label must be a string", "invalid_inference_api_key", "label")
  const label = value.trim()
  if (!label || label.length > 80) {
    throw invalidRequest("label must contain between 1 and 80 characters", "invalid_inference_api_key", "label")
  }
  return label
}

function defaultSecret(): string {
  return `nw-v2-${randomBytes(32).toString("base64url")}`
}

function preview(secret: string): string {
  return `${secret.slice(0, 6)}...${secret.slice(-6)}`
}

export class InferenceApiKeyService {
  readonly #repository: StateRepository
  readonly #now: () => number
  readonly #createId: () => string
  readonly #createSecret: () => string

  constructor(repository: StateRepository, options: InferenceApiKeyServiceOptions = {}) {
    this.#repository = repository
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? defaultSecret
  }

  async create(labelInput: string): Promise<CreatedInferenceApiKey> {
    const label = labelValue(labelInput)
    const secret = this.#createSecret()
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) {
      throw new ApiError("The inference API key generator returned an invalid secret", {
        status: 500,
        code: "inference_api_key_generation_failed"
      })
    }
    const digestHex = digest(secret).toString("hex")
    const id = this.#createId()

    const apiKey = await this.#repository.transact((state) => {
      if (state.inferenceApiKeys.some((candidate) => candidate.id === id || candidate.digest === digestHex)) {
        throw new ApiError("The inference API key generator produced a collision", {
          status: 500,
          code: "inference_api_key_collision"
        })
      }
      const now = new Date(this.#now()).toISOString()
      const stored: StoredInferenceApiKey = {
        id,
        label,
        digest: digestHex,
        preview: preview(secret),
        enabled: true,
        createdAt: now,
        updatedAt: now
      }
      state.inferenceApiKeys.push(stored)
      return toPublicInferenceApiKey(stored)
    })
    return { apiKey: cloneJson(apiKey), secret }
  }

  async list(): Promise<PublicInferenceApiKey[]> {
    const state = await this.#repository.snapshot()
    return cloneJson(state.inferenceApiKeys.map(toPublicInferenceApiKey))
  }

  async rename(id: string, labelInput: string): Promise<PublicInferenceApiKey> {
    const label = labelValue(labelInput)
    return this.#repository.transact((state) => {
      const key = state.inferenceApiKeys.find((candidate) => candidate.id === id)
      if (!key) throw keyNotFound()
      key.label = label
      key.updatedAt = new Date(this.#now()).toISOString()
      return toPublicInferenceApiKey(key)
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<PublicInferenceApiKey> {
    if (typeof enabled !== "boolean") {
      throw invalidRequest("enabled must be a boolean", "invalid_inference_api_key", "enabled")
    }
    return this.#repository.transact((state) => {
      const key = state.inferenceApiKeys.find((candidate) => candidate.id === id)
      if (!key) throw keyNotFound()
      key.enabled = enabled
      key.updatedAt = new Date(this.#now()).toISOString()
      return toPublicInferenceApiKey(key)
    })
  }

  async update(id: string, input: UpdateInferenceApiKeyInput): Promise<PublicInferenceApiKey> {
    if (input.label === undefined && input.enabled === undefined) {
      throw invalidRequest("At least one inference API key field is required", "invalid_inference_api_key")
    }
    const label = input.label === undefined ? undefined : labelValue(input.label)
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw invalidRequest("enabled must be a boolean", "invalid_inference_api_key", "enabled")
    }
    return this.#repository.transact((state) => {
      const key = state.inferenceApiKeys.find((candidate) => candidate.id === id)
      if (!key) throw keyNotFound()
      if (label !== undefined) key.label = label
      if (input.enabled !== undefined) key.enabled = input.enabled
      key.updatedAt = new Date(this.#now()).toISOString()
      return toPublicInferenceApiKey(key)
    })
  }

  async toggle(id: string, enabled?: boolean): Promise<PublicInferenceApiKey> {
    if (enabled !== undefined) return this.setEnabled(id, enabled)
    return this.#repository.transact((state) => {
      const key = state.inferenceApiKeys.find((candidate) => candidate.id === id)
      if (!key) throw keyNotFound()
      key.enabled = !key.enabled
      key.updatedAt = new Date(this.#now()).toISOString()
      return toPublicInferenceApiKey(key)
    })
  }

  async delete(id: string): Promise<void> {
    await this.#repository.transact((state) => {
      const index = state.inferenceApiKeys.findIndex((candidate) => candidate.id === id)
      if (index < 0) throw keyNotFound()
      state.inferenceApiKeys.splice(index, 1)
    })
  }

  async verify(secret: unknown): Promise<boolean> {
    return (await this.authenticate(secret)) !== null
  }

  async authenticate(secret: unknown): Promise<PublicInferenceApiKey | null> {
    if (typeof secret !== "string" || secret.length < 1 || secret.length > 512) return null
    const provided = digest(secret)
    const state = await this.#repository.snapshot()
    let matched: StoredInferenceApiKey | undefined
    for (const key of state.inferenceApiKeys) {
      const expected = Buffer.from(key.digest, "hex")
      const equal = expected.length === provided.length && timingSafeEqual(provided, expected)
      if (key.enabled && equal) matched = key
    }
    return matched ? cloneJson(toPublicInferenceApiKey(matched)) : null
  }
}
