import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parse, stringify } from "yaml"
import { ApiError } from "../shared/errors"
import { cloneJson } from "../shared/json"
import {
  createEmptyV2State,
  parseV2State,
  type V2State
} from "./schema"

export interface FileStateRepositoryOptions {
  initialState?: V2State
  beforePromote?: (temporaryPath: string) => void | Promise<void>
}

interface PersistOptions {
  rotatePrimary: boolean
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")
}

function apiError(message: string, code: string, cause?: unknown): ApiError {
  return new ApiError(message, { status: 500, code, cause })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function bestEffortChmod(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows does not consistently expose POSIX mode bits.
  }
}

async function bestEffortSyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  }
}

export class V2StateRepository {
  readonly filePath: string
  readonly backupPath: string
  #snapshot: V2State
  #tail: Promise<void> = Promise.resolve()
  readonly #beforePromote?: (temporaryPath: string) => void | Promise<void>

  private constructor(filePath: string, snapshot: V2State, options: FileStateRepositoryOptions) {
    this.filePath = resolve(filePath)
    this.backupPath = `${this.filePath}.bak`
    this.#snapshot = cloneJson(snapshot)
    this.#beforePromote = options.beforePromote
  }

  static async open(filePath: string, options: FileStateRepositoryOptions = {}): Promise<V2StateRepository> {
    const resolvedPath = resolve(filePath)
    const backupPath = `${resolvedPath}.bak`
    let snapshot: V2State

    try {
      snapshot = await V2StateRepository.readStateFile(resolvedPath)
    } catch (error) {
      if (!isMissing(error)) {
        const typed = error instanceof ApiError ? error : apiError("The v2 state file could not be read", "state_read_failed", error)
        // A malformed primary can be the result of an interrupted external write.
        // Never use a backup to hide an explicit non-v2 state file.
        if (typed.code === "state_version_unsupported") throw typed
        if (!await exists(backupPath)) throw typed
        snapshot = await V2StateRepository.readStateFile(backupPath)
        const repository = new V2StateRepository(resolvedPath, snapshot, options)
        await repository.persist(snapshot, { rotatePrimary: false })
        return repository
      }

      if (await exists(backupPath)) {
        snapshot = await V2StateRepository.readStateFile(backupPath)
        const repository = new V2StateRepository(resolvedPath, snapshot, options)
        await repository.persist(snapshot, { rotatePrimary: false })
        return repository
      }

      snapshot = options.initialState ? parseV2State(options.initialState) : createEmptyV2State()
      const repository = new V2StateRepository(resolvedPath, snapshot, options)
      await repository.persist(snapshot, { rotatePrimary: false })
      return repository
    }

    return new V2StateRepository(resolvedPath, snapshot, options)
  }

  private static async readStateFile(path: string): Promise<V2State> {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if (isMissing(error)) throw error
      throw apiError("The v2 state file could not be read", "state_read_failed", error)
    }

    let value: unknown
    try {
      value = parse(text)
    } catch (error) {
      throw apiError("The v2 state file contains invalid YAML", "state_parse_failed", error)
    }
    return parseV2State(value)
  }

  async snapshot(): Promise<V2State> {
    await this.#tail
    return cloneJson(this.#snapshot)
  }

  async assertReady(): Promise<void> {
    await this.#tail
    const probePath = `${this.filePath}.${randomUUID()}.ready`
    let probeHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      probeHandle = await open(probePath, "wx", 0o600)
      await probeHandle.close()
      probeHandle = undefined
      await unlink(probePath)
    } catch (error) {
      if (probeHandle) await probeHandle.close().catch(() => undefined)
      await unlink(probePath).catch(() => undefined)
      throw apiError("The v2 state directory is not writable", "state_readiness_failed", error)
    }
  }

  async transact<T>(mutator: (draft: V2State) => T | Promise<T>): Promise<T> {
    const operation = this.#tail.then(async () => {
      const draft = cloneJson(this.#snapshot)
      const result = await mutator(draft)
      // Validate before any durable operation or publication.
      const validated = parseV2State(draft)
      const outwardResult = cloneJson(result)
      await this.persist(validated, { rotatePrimary: true })
      this.#snapshot = cloneJson(validated)
      return outwardResult
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async persist(state: V2State, options: PersistOptions): Promise<void> {
    const content = stringify(state)
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined
    let rotated = false

    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600)
      await temporaryHandle.writeFile(content, "utf8")
      await temporaryHandle.sync()
      await temporaryHandle.close()
      temporaryHandle = undefined
      await this.#beforePromote?.(temporaryPath)

      if (options.rotatePrimary && await exists(this.filePath)) {
        try {
          await unlink(this.backupPath)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        await rename(this.filePath, this.backupPath)
        rotated = true
        await bestEffortChmod(this.backupPath)
      }

      await rename(temporaryPath, this.filePath)
      await bestEffortChmod(this.filePath)
      await bestEffortSyncDirectory(directory)
    } catch (error) {
      if (temporaryHandle) {
        try {
          await temporaryHandle.close()
        } catch {
          // Preserve the original persistence error.
        }
      }
      if (rotated) {
        try {
          if (!await exists(this.filePath)) await rename(this.backupPath, this.filePath)
        } catch {
          // The backup remains available for startup recovery.
        }
      }
      throw error instanceof ApiError
        ? error
        : apiError("The v2 state file could not be persisted", "state_write_failed", error)
    } finally {
      try {
        await unlink(temporaryPath)
      } catch {
        // The temporary file may already have been promoted.
      }
    }
  }

  /** Test and maintenance hook: waits for all queued writes. */
  async idle(): Promise<void> {
    await this.#tail
  }
}

export type StateRepository = V2StateRepository
