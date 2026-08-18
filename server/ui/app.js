/* global Vue, lucide, NeuralwattRender */
const { createApp, nextTick } = Vue

class ApiRequestError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
  }
}

function errorMessage(payload, fallback) {
  if (typeof payload === "string" && payload) return payload
  if (payload && typeof payload.error === "string") return payload.error
  if (payload && payload.error && typeof payload.error.message === "string") return payload.error.message
  if (payload && typeof payload.message === "string") return payload.message
  return fallback
}

function newAccountForm() {
  return {
    editingId: "",
    revision: null,
    label: "",
    email: "",
    password: "",
    cookie: "",
    clearCookie: false,
    enabled: true,
    pending: false
  }
}

createApp({
  render: NeuralwattRender,
  data() {
    return {
      sessionReady: false,
      authenticated: false,
      hasPassword: true,
      bootstrapConfigured: true,
      csrfToken: "",
      expiresAt: "",
      authForm: { bootstrapToken: "", password: "", confirm: "" },
      authError: "",
      authPending: false,
      sidebarOpen: false,
      activeTab: "overview",
      navItems: [
        { id: "overview", label: "概览", title: "运行概览", icon: "layout-dashboard" },
        { id: "accounts", label: "账号", title: "上游账号", icon: "users-round" },
        { id: "keys", label: "API keys", title: "访问密钥", icon: "key-round" },
        { id: "requestRecords", label: "请求记录", title: "请求记录", icon: "scroll-text" },
        { id: "models", label: "模型", title: "模型目录", icon: "boxes" },
        { id: "settings", label: "参数", title: "生成参数", icon: "sliders-horizontal" },
        { id: "tester", label: "测试台", title: "接口测试台", icon: "flask-conical" },
        { id: "security", label: "安全", title: "管理员安全", icon: "shield" }
      ],
      health: { text: "检查中", className: "unknown" },
      globalError: "",
      notice: { text: "", kind: "" },
      noticeTimer: 0,
      resourceErrors: { accounts: "", keys: "", models: "", defaults: "", requestRecords: "" },
      loading: { accounts: false, keys: false, models: false, defaults: false, requestRecords: false },
      accounts: [],
      keys: [],
      requestRecords: [],
      requestRecordsEnabled: false,
      requestRecordLimits: { maxRecords: 0, maxCaptureBytes: 0, maxTotalBytes: 0 },
      requestRecordPending: { settings: false, clear: false },
      expandedRequestRecordIds: [],
      catalog: { data: [], scope: null, fetchedAt: null },
      defaults: { temperature: 0.7, maxTokens: 4096, topP: 1 },
      accountForm: newAccountForm(),
      busyId: "",
      keyLabel: "",
      keyPending: false,
      keySecret: null,
      modelPending: false,
      defaultsPending: false,
      tester: { model: "", message: "请只回复 TEST_OK", stream: true, pending: false, output: "", meta: "" },
      passwordForm: { current: "", next: "", confirm: "" },
      passwordPending: false
    }
  },
  computed: {
    currentNav() {
      return this.navItems.find((item) => item.id === this.activeTab) || this.navItems[0]
    },
    enabledAccounts() {
      return this.accounts.filter((account) => account.enabled)
    },
    readyAccounts() {
      return this.accounts.filter((account) => account.enabled && account.status === "ready")
    },
    expiredAccounts() {
      return this.accounts.filter((account) => account.enabled && ["expired", "login_failed", "manual_cookie_required", "temporarily_unavailable"].includes(account.status))
    },
    enabledKeys() {
      return this.keys.filter((key) => key.enabled)
    },
    models() {
      return Array.isArray(this.catalog.data) ? this.catalog.data.filter((model) => model && typeof model.id === "string") : []
    }
  },
  methods: {
    renderIcons() {
      requestAnimationFrame(() => {
        if (window.lucide && typeof window.lucide.createIcons === "function") {
          window.lucide.createIcons({ icons: window.lucide.icons, attrs: { "stroke-width": 1.8 } })
        }
      })
    },
    async afterRender() {
      await nextTick()
      this.renderIcons()
    },
    notify(text, kind = "success") {
      this.notice = { text, kind }
      clearTimeout(this.noticeTimer)
      if (text) this.noticeTimer = setTimeout(() => { this.notice = { text: "", kind: "" } }, 5000)
      this.afterRender()
    },
    clearConsoleState() {
      this.csrfToken = ""
      this.expiresAt = ""
      this.accounts = []
      this.keys = []
      this.requestRecords = []
      this.requestRecordsEnabled = false
      this.requestRecordLimits = { maxRecords: 0, maxCaptureBytes: 0, maxTotalBytes: 0 }
      this.requestRecordPending = { settings: false, clear: false }
      this.expandedRequestRecordIds = []
      this.catalog = { data: [], scope: null, fetchedAt: null }
      this.resourceErrors = { accounts: "", keys: "", models: "", defaults: "", requestRecords: "" }
      this.accountForm = newAccountForm()
      this.keySecret = null
    },
    async resetForUnauthorized() {
      this.authenticated = false
      this.sessionReady = true
      this.clearConsoleState()
      try {
        const response = await fetch("/api/admin/session", { credentials: "same-origin", cache: "no-store" })
        if (response.ok) {
          const session = await response.json()
          this.hasPassword = Boolean(session.hasPassword)
          this.bootstrapConfigured = Boolean(session.bootstrapConfigured)
        }
      } catch (error) {
        this.authError = "会话已失效，且无法刷新管理员状态。"
      }
      this.afterRender()
    },
    async api(path, options = {}) {
      const method = (options.method || "GET").toUpperCase()
      const headers = { ...(options.headers || {}) }
      const hasBody = options.body !== undefined && options.body !== null
      if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json"
      if (!options.skipCsrf && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (!this.csrfToken) throw new ApiRequestError("管理员会话缺少 CSRF 令牌，请重新登录。", 401)
        headers["x-csrf-token"] = this.csrfToken
      }
      let response
      try {
        response = await fetch(path, { ...options, method, headers, credentials: "same-origin", cache: "no-store" })
      } catch (error) {
        throw new ApiRequestError("网络请求失败，请检查服务连接。")
      }
      const raw = await response.text()
      let payload = null
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch (error) {
          payload = raw
        }
      }
      if (!response.ok) {
        const message = errorMessage(payload, `请求失败（${response.status}）`)
        if (response.status === 401) await this.resetForUnauthorized()
        throw new ApiRequestError(message, response.status)
      }
      return payload || {}
    },
    async fetchSession() {
      let response
      try {
        response = await fetch("/api/admin/session", { credentials: "same-origin", cache: "no-store" })
      } catch (error) {
        throw new ApiRequestError("无法连接管理服务。")
      }
      if (!response.ok) throw new ApiRequestError(`无法读取管理员会话（${response.status}）`, response.status)
      const session = await response.json()
      this.authenticated = Boolean(session.authenticated)
      this.hasPassword = Boolean(session.hasPassword)
      this.bootstrapConfigured = Boolean(session.bootstrapConfigured)
      this.csrfToken = session.csrfToken || ""
      this.expiresAt = session.expiresAt || ""
      await this.afterRender()
      return session
    },
    async bootstrap() {
      try {
        await this.fetchSession()
        await this.checkHealth()
        if (this.authenticated) await this.refreshAll()
      } catch (error) {
        this.authError = error.message
        this.globalError = error.message
      } finally {
        this.sessionReady = true
        this.afterRender()
      }
    },
    async login() {
      if (!this.authForm.password) {
        this.authError = "请输入管理员密码。"
        return
      }
      this.authPending = true
      this.authError = ""
      try {
        const session = await this.api("/api/admin/login", {
          method: "POST",
          body: JSON.stringify({ password: this.authForm.password }),
          skipCsrf: true
        })
        this.authenticated = Boolean(session.authenticated)
        this.csrfToken = session.csrfToken || ""
        this.expiresAt = session.expiresAt || ""
        this.authForm.password = ""
        await this.refreshAll()
        this.notify("管理员会话已建立。")
      } catch (error) {
        this.authError = error.message
      } finally {
        this.authPending = false
        this.afterRender()
      }
    },
    async setup() {
      if (this.authForm.password.length < 8) {
        this.authError = "管理员密码至少需要 8 位。"
        return
      }
      if (this.authForm.password !== this.authForm.confirm) {
        this.authError = "两次输入的密码不一致。"
        return
      }
      this.authPending = true
      this.authError = ""
      try {
        const session = await this.api("/api/admin/setup", {
          method: "POST",
          body: JSON.stringify({ bootstrapToken: this.authForm.bootstrapToken, password: this.authForm.password }),
          skipCsrf: true
        })
        this.authenticated = Boolean(session.authenticated)
        this.hasPassword = true
        this.csrfToken = session.csrfToken || ""
        this.expiresAt = session.expiresAt || ""
        this.authForm = { bootstrapToken: "", password: "", confirm: "" }
        await this.refreshAll()
        this.notify("管理员已初始化。")
      } catch (error) {
        this.authError = error.message
      } finally {
        this.authPending = false
        this.afterRender()
      }
    },
    async logout() {
      try {
        await this.api("/api/admin/logout", { method: "POST" })
      } catch (error) {
        if (error.status !== 401) this.notify(error.message, "error")
      } finally {
        this.authenticated = false
        this.clearConsoleState()
        await this.fetchSession().catch((error) => { this.authError = error.message })
        this.afterRender()
      }
    },
    async checkHealth() {
      try {
        const response = await fetch("/health", { cache: "no-store" })
        if (!response.ok) throw new Error()
        this.health = { text: "服务在线", className: "ready" }
      } catch (error) {
        this.health = { text: "服务不可用", className: "failed" }
      }
      this.afterRender()
    },
    async loadResource(name, loader) {
      this.loading[name] = true
      this.resourceErrors[name] = ""
      try {
        await loader()
      } catch (error) {
        if (error.status !== 401) {
          this.resourceErrors[name] = error.message
          const resourceLabel = { accounts: "账号", keys: "API key", models: "模型目录", defaults: "生成参数", requestRecords: "请求记录" }[name] || name
          this.globalError = `${resourceLabel}加载失败：${error.message}`
        }
      } finally {
        this.loading[name] = false
        this.afterRender()
      }
    },
    async refreshAll() {
      if (!this.authenticated) return
      this.globalError = ""
      await Promise.all([
        this.loadResource("accounts", () => this.loadAccounts()),
        this.loadResource("keys", () => this.loadKeys()),
        this.loadResource("models", () => this.loadModels()),
        this.loadResource("defaults", () => this.loadDefaults()),
        this.loadResource("requestRecords", () => this.loadRequestRecords())
      ])
      await this.checkHealth()
    },
    async loadAccounts() {
      const data = await this.api("/api/accounts")
      this.accounts = Array.isArray(data.accounts) ? data.accounts : []
    },
    async loadKeys() {
      const data = await this.api("/api/proxy-keys")
      this.keys = Array.isArray(data.keys) ? data.keys : []
    },
    async loadRequestRecords() {
      const data = await this.api("/api/request-records")
      if (typeof data.enabled !== "boolean" || !Array.isArray(data.records)) {
        throw new ApiRequestError("服务返回的请求记录格式无效。")
      }
      this.requestRecordsEnabled = data.enabled
      this.requestRecords = data.records
      const limits = data.retention && typeof data.retention === "object" ? data.retention : data.limits || {}
      this.requestRecordLimits = {
        maxRecords: Number(limits.maxRecords) || 0,
        maxCaptureBytes: Number(limits.maxBodyBytes ?? limits.maxCaptureBytes) || 0,
        maxTotalBytes: Number(limits.maxTotalBytes) || 0
      }
      const availableIds = new Set(this.requestRecords.map((record) => record.id))
      this.expandedRequestRecordIds = this.expandedRequestRecordIds.filter((id) => availableIds.has(id))
    },
    async refreshRequestRecords() {
      await this.loadResource("requestRecords", () => this.loadRequestRecords())
    },
    async setRequestRecording(enabled) {
      if (this.requestRecordPending.settings) return
      this.requestRecordPending.settings = true
      try {
        const data = await this.api("/api/request-records/settings", {
          method: "PUT",
          body: JSON.stringify({ enabled: Boolean(enabled) })
        })
        if (typeof data.enabled !== "boolean") throw new ApiRequestError("服务没有返回请求记录状态。")
        this.requestRecordsEnabled = data.enabled
        this.notify(data.enabled ? "请求记录已开启，请在排障结束后及时关闭并清空。" : "请求记录已关闭。")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.requestRecordPending.settings = false
        this.afterRender()
      }
    },
    async clearRequestRecords() {
      if (!this.requestRecords.length || this.requestRecordPending.clear) return
      const count = this.requestRecords.length
      if (!window.confirm(`清除全部 ${count} 条请求记录？记录内容将无法恢复。`)) return
      this.requestRecordPending.clear = true
      try {
        const data = await this.api("/api/request-records", { method: "DELETE" })
        this.requestRecords = []
        this.expandedRequestRecordIds = []
        const deletedCount = Number.isInteger(data.deletedCount) ? data.deletedCount : count
        this.notify(`已清除 ${deletedCount} 条请求记录。`)
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.requestRecordPending.clear = false
        this.afterRender()
      }
    },
    toggleRequestRecord(id) {
      if (!id) return
      this.expandedRequestRecordIds = this.expandedRequestRecordIds.includes(id)
        ? this.expandedRequestRecordIds.filter((value) => value !== id)
        : [...this.expandedRequestRecordIds, id]
      this.afterRender()
    },
    isRequestRecordExpanded(id) {
      return this.expandedRequestRecordIds.includes(id)
    },
    async loadModels() {
      const data = await this.api("/api/models")
      const catalog = data.models && typeof data.models === "object" ? data.models : { data: [], scope: null, fetchedAt: null }
      this.catalog = { data: Array.isArray(catalog.data) ? catalog.data : [], scope: catalog.scope || null, fetchedAt: catalog.fetchedAt || null }
      if (!this.tester.model && this.models.length) this.tester.model = this.models[0].id
    },
    async loadDefaults() {
      const data = await this.api("/api/generation-defaults")
      if (!data.defaults || typeof data.defaults !== "object") throw new ApiRequestError("服务返回的生成参数格式无效。")
      this.defaults = {
        temperature: Number(data.defaults.temperature),
        maxTokens: Number(data.defaults.maxTokens),
        topP: Number(data.defaults.topP)
      }
    },
    selectTab(tab) {
      this.activeTab = tab
      this.sidebarOpen = false
      if (tab === "requestRecords" && this.authenticated) {
        void this.refreshRequestRecords()
      }
      this.afterRender()
    },
    resetAccountForm() {
      this.accountForm = newAccountForm()
      this.afterRender()
    },
    editAccount(account) {
      this.accountForm = {
        editingId: account.id,
        revision: account.revision,
        label: account.label,
        email: account.email,
        password: "",
        cookie: "",
        clearCookie: false,
        enabled: Boolean(account.enabled),
        pending: false
      }
      window.scrollTo({ top: 0, behavior: "smooth" })
      this.afterRender()
    },
    async saveAccount() {
      const form = this.accountForm
      if (!form.label || !form.email) {
        this.notify("请填写显示名称和邮箱。", "error")
        return
      }
      if (!form.editingId && !form.password) {
        this.notify("新增账号必须提供密码。", "error")
        return
      }
      if (form.cookie && form.clearCookie) {
        this.notify("不能同时提交新 Cookie 和清除 Cookie。", "error")
        return
      }
      form.pending = true
      try {
        if (form.editingId) {
          const payload = { revision: form.revision, label: form.label, email: form.email, enabled: form.enabled }
          if (form.password) payload.password = form.password
          if (form.cookie) payload.cookie = form.cookie
          if (form.clearCookie) payload.cookie = null
          await this.api(`/api/accounts/${encodeURIComponent(form.editingId)}`, { method: "PATCH", body: JSON.stringify(payload) })
        } else {
          const payload = { label: form.label, email: form.email, password: form.password, enabled: form.enabled }
          if (form.cookie) payload.cookie = form.cookie
          await this.api("/api/accounts", { method: "POST", body: JSON.stringify(payload) })
        }
        this.resetAccountForm()
        await this.loadResource("accounts", () => this.loadAccounts())
        this.notify("账号已保存。")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        form.pending = false
        this.afterRender()
      }
    },
    async accountAction(action, account) {
      if (action === "delete" && !window.confirm(`删除账号“${account.label}”？该操作不可撤销。`)) return
      this.busyId = account.id
      try {
        if (action === "delete") {
          await this.api(`/api/accounts/${encodeURIComponent(account.id)}?revision=${encodeURIComponent(account.revision)}`, { method: "DELETE" })
          this.notify("账号已删除。")
        } else if (action === "toggle") {
          await this.api(`/api/accounts/${encodeURIComponent(account.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ revision: account.revision, enabled: !account.enabled })
          })
          this.notify(account.enabled ? "账号已停用。" : "账号已启用。")
        } else if (action === "login") {
          await this.api(`/api/accounts/${encodeURIComponent(account.id)}/login`, { method: "POST" })
          this.notify("账号登录完成。")
        } else if (action === "check") {
          const result = await this.api(`/api/accounts/${encodeURIComponent(account.id)}/check`, { method: "POST" })
          this.notify(result.ok ? "账号会话有效。" : `账号会话不可用：${result.reason || "未知原因"}`, result.ok ? "success" : "error")
        }
        await this.loadResource("accounts", () => this.loadAccounts())
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.busyId = ""
        this.afterRender()
      }
    },
    async createKey() {
      const label = this.keyLabel.trim()
      if (!label) {
        this.notify("请输入密钥名称。", "error")
        return
      }
      this.keyPending = true
      try {
        const data = await this.api("/api/proxy-keys", { method: "POST", body: JSON.stringify({ label }) })
        if (!data.secret || !data.key) throw new ApiRequestError("服务没有返回新密钥。")
        this.keyLabel = ""
        this.keySecret = { label: data.key.label, secret: data.secret }
        await this.loadResource("keys", () => this.loadKeys())
        this.notify("新 API key 已创建。")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.keyPending = false
        this.afterRender()
      }
    },
    async renameKey(key) {
      const label = window.prompt("API key 名称", key.label)
      if (label === null) return
      const trimmed = label.trim()
      if (!trimmed) {
        this.notify("密钥名称不能为空。", "error")
        return
      }
      try {
        await this.api(`/api/proxy-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ label: trimmed }) })
        await this.loadResource("keys", () => this.loadKeys())
        this.notify("API key 名称已更新。")
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    async toggleKey(key) {
      try {
        await this.api(`/api/proxy-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !key.enabled }) })
        await this.loadResource("keys", () => this.loadKeys())
        this.notify(key.enabled ? "API key 已停用。" : "API key 已启用。")
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    async deleteKey(key) {
      if (!window.confirm(`删除 API key“${key.label}”？客户端将立即失去访问权限。`)) return
      try {
        await this.api(`/api/proxy-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" })
        await this.loadResource("keys", () => this.loadKeys())
        this.notify("API key 已删除。")
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    async refreshModels() {
      this.modelPending = true
      this.resourceErrors.models = ""
      try {
        const data = await this.api("/api/models/refresh", { method: "POST" })
        const catalog = data.models && typeof data.models === "object" ? data.models : null
        if (!catalog) throw new ApiRequestError("服务返回的模型目录格式无效。")
        this.catalog = { data: Array.isArray(catalog.data) ? catalog.data : [], scope: catalog.scope || null, fetchedAt: catalog.fetchedAt || null }
        if (!this.tester.model && this.models.length) this.tester.model = this.models[0].id
        this.notify(`模型目录已同步，共 ${this.models.length} 个模型。`)
      } catch (error) {
        this.resourceErrors.models = error.message
        this.notify(error.message, "error")
      } finally {
        this.modelPending = false
        this.afterRender()
      }
    },
    async saveDefaults() {
      const payload = {
        temperature: Number(this.defaults.temperature),
        maxTokens: Number(this.defaults.maxTokens),
        topP: Number(this.defaults.topP)
      }
      if (!Number.isFinite(payload.temperature) || payload.temperature < 0 || payload.temperature > 2
        || !Number.isInteger(payload.maxTokens) || payload.maxTokens < 1 || payload.maxTokens > 1000000
        || !Number.isFinite(payload.topP) || payload.topP < 0 || payload.topP > 1) {
        this.notify("生成参数超出有效范围。", "error")
        return
      }
      this.defaultsPending = true
      try {
        const data = await this.api("/api/generation-defaults", { method: "PUT", body: JSON.stringify(payload) })
        this.defaults = data.defaults
        this.notify("生成参数已保存。")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.defaultsPending = false
        this.afterRender()
      }
    },
    async runTest() {
      if (!this.tester.model) {
        this.notify("请选择模型。", "error")
        return
      }
      if (!this.tester.message) {
        this.notify("请输入测试消息。", "error")
        return
      }
      this.tester.pending = true
      this.tester.output = ""
      this.tester.meta = "正在请求…"
      const startedAt = performance.now()
      try {
        const response = await fetch("/api/test-chat", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "x-csrf-token": this.csrfToken },
          body: JSON.stringify({ model: this.tester.model, messages: [{ role: "user", content: this.tester.message }], stream: this.tester.stream })
        })
        if (!response.ok) {
          const raw = await response.text()
          let payload = raw
          try { payload = raw ? JSON.parse(raw) : null } catch (error) {}
          if (response.status === 401) await this.resetForUnauthorized()
          throw new ApiRequestError(errorMessage(payload, `测试请求失败（${response.status}）`), response.status)
        }
        if (this.tester.stream) {
          await this.consumeTestStream(response, startedAt)
        } else {
          const payload = await response.json()
          const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
          const message = choice && choice.message ? choice.message : {}
          const content = typeof message.content === "string" ? message.content : ""
          if (!content.trim()) throw new ApiRequestError("测试响应没有正文内容。")
          if (typeof choice?.finish_reason !== "string" || !choice.finish_reason) {
            throw new ApiRequestError("测试响应缺少 finish_reason。")
          }
          this.tester.output = content
          this.tester.meta = `HTTP ${response.status} · finish_reason: ${choice.finish_reason} · ${(performance.now() - startedAt).toFixed(0)} ms`
        }
        if (!this.tester.meta || this.tester.meta === "正在请求…") this.tester.meta = `HTTP ${response.status} · ${(performance.now() - startedAt).toFixed(0)} ms`
        this.notify("测试请求完成。")
      } catch (error) {
        this.tester.output = error.message
        this.tester.meta = "请求失败"
        this.notify(error.message, "error")
      } finally {
        this.tester.pending = false
        this.afterRender()
      }
    },
    async consumeTestStream(response, startedAt) {
      if (!response.body) throw new ApiRequestError("服务没有返回流式响应体。")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let done = false
      let finishReason = ""
      let chunks = 0
      const consumeFrame = (frame) => {
        const lines = frame.replace(/\r/g, "").split("\n")
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
        if (!data) return
        if (data === "[DONE]") {
          done = true
          return
        }
        let payload
        try {
          payload = JSON.parse(data)
        } catch (error) {
          throw new ApiRequestError("测试流包含无法解析的数据帧。")
        }
        if (payload.error) throw new ApiRequestError(errorMessage(payload, "上游返回错误。"))
        const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
        if (!choice) return
        chunks += 1
        const delta = choice.delta || {}
        if (typeof delta.content === "string") this.tester.output += delta.content
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
      while (true) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary)
          const separatorLength = buffer[boundary] === "\r" ? 4 : 2
          buffer = buffer.slice(boundary + separatorLength)
          consumeFrame(frame)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) consumeFrame(buffer)
      if (!done) throw new ApiRequestError("测试流在收到 [DONE] 前结束。")
      if (!finishReason) throw new ApiRequestError("测试流缺少 finish_reason。")
      if (!this.tester.output.trim()) throw new ApiRequestError("测试流没有正文内容。")
      this.tester.meta = `HTTP ${response.status} · ${chunks} 个数据帧 · finish_reason: ${finishReason} · ${(performance.now() - startedAt).toFixed(0)} ms`
    },
    async changePassword() {
      if (this.passwordForm.next.length < 8) {
        this.notify("新密码至少需要 8 位。", "error")
        return
      }
      if (this.passwordForm.next !== this.passwordForm.confirm) {
        this.notify("两次输入的新密码不一致。", "error")
        return
      }
      this.passwordPending = true
      try {
        const data = await this.api("/api/admin/password", {
          method: "PUT",
          body: JSON.stringify({ currentPassword: this.passwordForm.current, password: this.passwordForm.next })
        })
        this.csrfToken = data.csrfToken || this.csrfToken
        this.expiresAt = data.expiresAt || this.expiresAt
        this.passwordForm = { current: "", next: "", confirm: "" }
        this.notify("管理员密码已更新，其他会话已撤销。")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.passwordPending = false
        this.afterRender()
      }
    },
    async copySecret() {
      if (!this.keySecret?.secret) return
      try {
        try {
          await navigator.clipboard.writeText(this.keySecret.secret)
        } catch (error) {
          const input = document.createElement("textarea")
          input.value = this.keySecret.secret
          input.setAttribute("readonly", "")
          input.style.position = "fixed"
          input.style.opacity = "0"
          document.body.append(input)
          input.select()
          const copied = document.execCommand("copy")
          input.remove()
          if (!copied) throw new ApiRequestError("浏览器拒绝复制密钥。")
        }
        this.notify("密钥已复制到剪贴板。")
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    modelName(model) {
      return model?.metadata?.display_name || model?.display_name || model?.id || "未命名模型"
    },
    formatRequestSource(source) {
      return {
        openai: "OpenAI API",
        openai_api: "OpenAI API",
        chat_completions: "OpenAI API",
        admin_test: "管理测试台",
        test_chat: "管理测试台"
      }[source] || source || "未知来源"
    },
    formatRequestTime(value) {
      if (!value) return "-"
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hour12: false
      })
    },
    formatDuration(value) {
      const milliseconds = Number(value)
      if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-"
      if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
      if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} s`
      return `${(milliseconds / 60000).toFixed(1)} min`
    },
    formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return "未提供"
      if (bytes < 1024) return `${Math.round(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    },
    formatJson(value) {
      if (value === undefined) return "未记录"
      if (typeof value === "string") {
        if (!value) return "（空字符串）"
        try {
          return JSON.stringify(JSON.parse(value), null, 2)
        } catch (error) {
          return value
        }
      }
      try {
        return JSON.stringify(value, null, 2)
      } catch (error) {
        return String(value)
      }
    },
    requestStatusCode(value) {
      if (Number.isInteger(value)) return value
      if (!value || typeof value !== "object") return null
      for (const key of ["status", "statusCode", "httpStatus"]) {
        if (Number.isInteger(value[key])) return value[key]
      }
      return null
    },
    requestRecordStatusClass(record) {
      if (record?.client?.error) return "failed"
      const status = this.requestStatusCode(record?.client?.result)
      if (status !== null) {
        if (status >= 200 && status < 400) return "ready"
        if (status >= 400) return "failed"
        return "warning"
      }
      return record?.completedAt ? "ready" : "warning"
    },
    requestRecordStatusLabel(record) {
      if (record?.client?.error) return "失败"
      const status = this.requestStatusCode(record?.client?.result)
      if (status !== null) return `HTTP ${status}`
      return record?.completedAt ? "已完成" : "进行中"
    },
    upstreamStatusClass(attempt) {
      if (attempt?.error) return "failed"
      const status = this.requestStatusCode(attempt?.response) ?? this.requestStatusCode(attempt?.status)
      if (status === null) return "warning"
      if (status >= 200 && status < 400) return "ready"
      if (status >= 400) return "failed"
      return "warning"
    },
    upstreamStatusLabel(attempt) {
      const status = this.requestStatusCode(attempt?.response) ?? this.requestStatusCode(attempt?.status)
      if (attempt?.error && status === null) return "失败"
      return status !== null ? `HTTP ${status}` : "无响应"
    },
    formatTime(value) {
      if (!value) return "-"
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
    },
    statusLabel(status) {
      return {
        unknown: "未检查",
        ready: "可用",
        expired: "已过期",
        login_failed: "登录失败",
        manual_cookie_required: "需要 Cookie",
        temporarily_unavailable: "暂不可用"
      }[status] || status
    },
    statusClass(status) {
      if (status === "ready") return "ready"
      if (status === "manual_cookie_required" || status === "temporarily_unavailable") return "warning"
      if (status === "expired" || status === "login_failed") return "failed"
      return "muted"
    }
  },
  mounted() {
    document.getElementById("app-template")?.remove()
    this.renderIcons()
    this.bootstrap()
  },
  updated() {
    this.renderIcons()
  }
}).mount("#app-mount")
