import { ApiError } from "../shared/errors"
import type { StateRepository } from "../state/file-repository"
import { AdminSessionManager, type AdminSession } from "./admin-sessions"
import { LoginFailureLimiter } from "./login-limiter"
import { PasswordHasher } from "./passwords"

export interface AdminSecurityServiceOptions {
  passwordHasher?: PasswordHasher
  sessions?: AdminSessionManager
  loginLimiter?: LoginFailureLimiter
  canInitializePassword?: () => boolean | Promise<boolean>
}

export interface ChangeAdminPasswordInput {
  sessionToken: unknown
  csrfToken: unknown
  currentPassword: unknown
  newPassword: unknown
  limiterIdentifier: unknown
}

function passwordConflict(): ApiError {
  return new ApiError("The administrator password changed while the operation was in progress", {
    status: 409,
    code: "admin_password_revision_conflict"
  })
}

export class AdminSecurityService {
  readonly sessions: AdminSessionManager
  readonly loginLimiter: LoginFailureLimiter
  readonly #repository: StateRepository
  readonly #passwordHasher: PasswordHasher
  readonly #canInitializePassword: () => boolean | Promise<boolean>

  constructor(repository: StateRepository, options: AdminSecurityServiceOptions = {}) {
    this.#repository = repository
    this.#passwordHasher = options.passwordHasher ?? new PasswordHasher()
    this.sessions = options.sessions ?? new AdminSessionManager()
    this.loginLimiter = options.loginLimiter ?? new LoginFailureLimiter()
    this.#canInitializePassword = options.canInitializePassword ?? (() => false)
  }

  async hasPassword(): Promise<boolean> {
    return (await this.#repository.snapshot()).admin.passwordHash !== null
  }

  async initializePassword(newPassword: unknown): Promise<AdminSession> {
    if (!await this.#canInitializePassword()) {
      throw new ApiError("Administrator password initialization is not authorized", {
        status: 403,
        code: "admin_password_initialization_forbidden"
      })
    }
    const nextHash = await this.#passwordHasher.hash(newPassword)
    await this.#repository.transact((state) => {
      if (state.admin.passwordHash !== null) {
        throw new ApiError("The administrator password is already configured", {
          status: 409,
          code: "admin_password_already_configured"
        })
      }
      state.admin.passwordHash = nextHash
    })
    this.sessions.revokeAll()
    return this.sessions.create()
  }

  async login(password: unknown, limiterIdentifier: unknown): Promise<AdminSession> {
    this.loginLimiter.assertAllowed(limiterIdentifier)
    const passwordHash = (await this.#repository.snapshot()).admin.passwordHash
    if (passwordHash === null) {
      throw new ApiError("The administrator password is not configured", {
        status: 403,
        code: "admin_password_not_configured"
      })
    }

    const valid = await this.#passwordHasher.verify(password, passwordHash)
    if (!valid) {
      this.loginLimiter.recordFailure(limiterIdentifier)
      throw new ApiError("The administrator password is invalid", {
        status: 401,
        code: "invalid_admin_password"
      })
    }
    this.loginLimiter.recordSuccess(limiterIdentifier)
    return this.sessions.create()
  }

  async changePassword(input: ChangeAdminPasswordInput): Promise<AdminSession> {
    this.sessions.assertCsrf(input.sessionToken, input.csrfToken)
    this.loginLimiter.assertAllowed(input.limiterIdentifier)
    const currentHash = (await this.#repository.snapshot()).admin.passwordHash
    if (currentHash === null) {
      throw new ApiError("The administrator password is not configured", {
        status: 403,
        code: "admin_password_not_configured"
      })
    }
    if (!await this.#passwordHasher.verify(input.currentPassword, currentHash)) {
      this.loginLimiter.recordFailure(input.limiterIdentifier)
      throw new ApiError("The current administrator password is invalid", {
        status: 401,
        code: "invalid_admin_password"
      })
    }
    const nextHash = await this.#passwordHasher.hash(input.newPassword)
    await this.#repository.transact((state) => {
      if (state.admin.passwordHash !== currentHash) throw passwordConflict()
      state.admin.passwordHash = nextHash
    })
    this.loginLimiter.recordSuccess(input.limiterIdentifier)
    this.sessions.revokeAll()
    return this.sessions.create()
  }

  assertAuthenticated(sessionToken: unknown): void {
    this.sessions.assertAuthenticated(sessionToken)
  }

  assertMutationAuthorized(sessionToken: unknown, csrfToken: unknown): void {
    this.sessions.assertCsrf(sessionToken, csrfToken)
  }

  logout(sessionToken: unknown, csrfToken: unknown): void {
    this.sessions.assertCsrf(sessionToken, csrfToken)
    this.sessions.logout(sessionToken)
  }

  revokeAll(sessionToken: unknown, csrfToken: unknown): number {
    this.sessions.assertCsrf(sessionToken, csrfToken)
    return this.sessions.revokeAll()
  }
}
