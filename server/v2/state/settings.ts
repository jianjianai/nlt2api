import { invalidRequest } from "../shared/errors"
import { cloneJson, isJsonObject, type JsonObject } from "../shared/json"
import type { StateRepository } from "./file-repository"
import type { GenerationDefaults, StoredModelCatalog } from "./schema"

function validNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
}

export class SettingsService {
  readonly #repository: StateRepository
  readonly #now: () => number

  constructor(repository: StateRepository, options: { now?: () => number } = {}) {
    this.#repository = repository
    this.#now = options.now ?? Date.now
  }

  async getGenerationDefaults(): Promise<GenerationDefaults> {
    return cloneJson((await this.#repository.snapshot()).generationDefaults)
  }

  async setGenerationDefaults(input: GenerationDefaults): Promise<GenerationDefaults> {
    if (!validNumber(input.temperature, 0, 2)) {
      throw invalidRequest("temperature must be between 0 and 2", "invalid_generation_defaults", "temperature")
    }
    if (!validNumber(input.maxTokens, 1, 1_000_000) || !Number.isSafeInteger(input.maxTokens)) {
      throw invalidRequest("maxTokens must be an integer between 1 and 1000000", "invalid_generation_defaults", "maxTokens")
    }
    if (!validNumber(input.topP, 0, 1)) {
      throw invalidRequest("topP must be between 0 and 1", "invalid_generation_defaults", "topP")
    }
    return this.#repository.transact((state) => {
      state.generationDefaults = cloneJson(input)
      return state.generationDefaults
    })
  }

  async getModelCatalog(): Promise<StoredModelCatalog> {
    return cloneJson((await this.#repository.snapshot()).modelCatalog)
  }

  async replaceModelCatalog(input: { data: JsonObject[]; scope: string | null }): Promise<StoredModelCatalog> {
    if (!Array.isArray(input.data) || input.data.length > 10_000 || input.data.some((model) => !isJsonObject(model))) {
      throw invalidRequest("data must be a bounded array of model objects", "invalid_model_catalog", "data")
    }
    if (input.scope !== null && (typeof input.scope !== "string" || !input.scope.trim() || input.scope.length > 200)) {
      throw invalidRequest("scope must be null or a non-empty string no longer than 200 characters", "invalid_model_catalog", "scope")
    }
    return this.#repository.transact((state) => {
      state.modelCatalog = {
        data: cloneJson(input.data),
        scope: input.scope === null ? null : input.scope.trim(),
        fetchedAt: new Date(this.#now()).toISOString()
      }
      return state.modelCatalog
    })
  }
}
