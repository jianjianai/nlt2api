/* global Vue */
const { createApp } = Vue

createApp({
  data() {
    return {
      authed: false,
      hasPassword: true,
      loginPassword: "",
      loginConfirm: "",
      setupKey: "",
      loginError: "",
      loginPending: false,
      health: { text: "检查服务…", className: "status-unknown" },
      proxyKeys: [],
      proxyKeyLabel: "",
      proxyKeyPending: false,
      accounts: [],
      editingId: "",
      form: { label: "", email: "", password: "", cookie: "" },
      saving: false,
      busyId: "",
      modelCatalog: null,
      models: [],
      refreshingModels: false,
      generation: { temperature: 0.7, maxTokens: 4096, topP: 1 },
      savingDefaults: false,
      test: { model: "", keyId: "", message: "请只回复 TEST_OK", output: "等待测试", pending: false },
      pwd: { current: "", next: "", confirm: "" },
      pwdPending: false,
      notice: { text: "", kind: "" },
      noticeTimer: 0
    }
  },
  computed: {
    enabledProxyKeys() {
      return this.proxyKeys.filter((key) => key.enabled)
    },
    modelStatusText() {
      if (this.modelCatalog === null) return "尚未加载本地保存的模型目录。"
      return `已保存 ${this.models.length} 个模型 · 目录范围：${this.modelCatalog.scope || "local"} · 获取时间：${this.formatTime(this.modelCatalog.fetchedAt)}`
    }
  },
  methods: {
    notify(text, kind = "") {
      this.notice = { text, kind }
      clearTimeout(this.noticeTimer)
      if (text) {
        this.noticeTimer = setTimeout(() => { this.notice = { text: "", kind: "" } }, 4000)
      }
    },
    async api(path, options = {}) {
      const headers = { ...(options.headers || {}) }
      if (options.body) headers["Content-Type"] = "application/json"
      const response = await fetch(path, { ...options, headers })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : (data.error && data.error.message) || `请求失败（${response.status}）`)
      }
      return data
    },
    async bootstrap() {
      this.checkHealth()
      try {
        const session = await (await fetch("/api/admin/session")).json()
        this.hasPassword = Boolean(session.hasPassword)
        this.authed = Boolean(session.authenticated)
        if (this.authed) await this.loadAll()
      } catch {
        this.notify("无法连接服务", "error")
      }
    },
    async loadAll() {
      await Promise.all([
        this.loadProxyKeys().catch(() => {}),
        this.loadAccounts().catch(() => {}),
        this.loadModels().catch(() => {}),
        this.loadGenerationDefaults().catch(() => {})
      ])
    },
    async login() {
      if (!this.loginPassword) {
        this.loginError = "请输入密码"
        return
      }
      this.loginPending = true
      this.loginError = ""
      try {
        await this.api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: this.loginPassword }) })
        this.authed = true
        this.loginPassword = ""
        await this.loadAll()
      } catch (error) {
        this.loginError = error.message
      } finally {
        this.loginPending = false
      }
    },
    async setupPassword() {
      if (!this.setupKey) {
        this.loginError = "请输入本地代理 Key"
        return
      }
      if (this.loginPassword.length < 8) {
        this.loginError = "新密码至少 8 位"
        return
      }
      if (this.loginPassword !== this.loginConfirm) {
        this.loginError = "两次输入的密码不一致"
        return
      }
      this.loginPending = true
      this.loginError = ""
      try {
        await this.api("/api/admin/password", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.setupKey}` },
          body: JSON.stringify({ password: this.loginPassword })
        })
        this.hasPassword = true
        this.authed = true
        this.loginPassword = ""
        this.loginConfirm = ""
        this.setupKey = ""
        await this.loadAll()
      } catch (error) {
        this.loginError = error.message
      } finally {
        this.loginPending = false
      }
    },
    async logout() {
      await fetch("/api/admin/logout", { method: "POST" }).catch(() => {})
      this.authed = false
      this.accounts = []
      this.proxyKeys = []
    },
    async checkHealth() {
      try {
        const response = await fetch("/health")
        if (!response.ok) throw new Error("health")
        this.health = { text: "服务在线", className: "status-ready" }
      } catch {
        this.health = { text: "服务不可用", className: "status-error" }
      }
    },
    async loadProxyKeys() {
      const data = await this.api("/api/proxy-keys")
      this.proxyKeys = data.keys || []
      if (!this.test.keyId && this.enabledProxyKeys.length > 0) {
        this.test.keyId = this.enabledProxyKeys[0].id
      }
    },
    async createProxyKey() {
      const label = this.proxyKeyLabel.trim()
      if (!label) {
        this.notify("请输入 Key 名称。", "error")
        return
      }
      this.proxyKeyPending = true
      try {
        const data = await this.api("/api/proxy-keys", { method: "POST", body: JSON.stringify({ label }) })
        this.proxyKeyLabel = ""
        await this.loadProxyKeys()
        this.notify(`已生成 Key：${data.key.label}。`, "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.proxyKeyPending = false
      }
    },
    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        const fallback = document.createElement("textarea")
        fallback.value = text
        fallback.readOnly = true
        fallback.style.position = "fixed"
        fallback.style.opacity = "0"
        document.body.append(fallback)
        fallback.select()
        const ok = document.execCommand("copy")
        fallback.remove()
        return ok
      }
    },
    async proxyKeyAction(action, key) {
      try {
        if (action === "copy") {
          await this.copyText(key.value)
          this.notify(`${key.label} 已复制。`, "success")
          return
        }
        if (action === "rename") {
          const label = window.prompt("Key 名称", key.label)
          if (label === null) return
          await this.api(`/api/proxy-keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ label }) })
        } else if (action === "delete") {
          if (!window.confirm(`确认删除 Key“${key.label}”？此操作会立即撤销其 API 访问权限。`)) return
          await this.api(`/api/proxy-keys/${key.id}`, { method: "DELETE" })
        } else if (action === "toggle") {
          await this.api(`/api/proxy-keys/${key.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !key.enabled }) })
        }
        await this.loadProxyKeys()
        const message = action === "delete"
          ? `${key.label} 已删除。`
          : action === "rename"
            ? "Key 名称已更新。"
            : `${key.label} 已${key.enabled ? "停用" : "启用"}。`
        this.notify(message, "success")
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    async loadAccounts() {
      const data = await this.api("/api/accounts")
      this.accounts = data.accounts || []
    },
    resetForm() {
      this.editingId = ""
      this.form = { label: "", email: "", password: "", cookie: "" }
    },
    editAccount(account) {
      this.editingId = account.id
      this.form = { label: account.label, email: account.email, password: "", cookie: "" }
      window.scrollTo({ top: 0, behavior: "smooth" })
      this.notify("编辑模式：密码留空表示保留原密码；需要替换 Cookie 时再填写。")
    },
    async saveAccount() {
      if (!this.form.label || !this.form.email) {
        this.notify("请填写显示名称和邮箱。", "error")
        return
      }
      if (!this.editingId && !this.form.password) {
        this.notify("新增账号必须填写密码。", "error")
        return
      }
      this.saving = true
      try {
        let data
        if (this.editingId) {
          const payload = { label: this.form.label, email: this.form.email }
          if (this.form.password) payload.password = this.form.password
          data = await this.api(`/api/accounts/${this.editingId}`, { method: "PATCH", body: JSON.stringify(payload) })
        } else {
          data = await this.api("/api/accounts", {
            method: "POST",
            body: JSON.stringify({ label: this.form.label, email: this.form.email, password: this.form.password })
          })
        }
        const accountId = data.account?.id
        if (this.form.cookie && accountId) {
          await this.api(`/api/accounts/${accountId}/session-cookie`, { method: "POST", body: JSON.stringify({ cookie: this.form.cookie }) })
        }
        this.resetForm()
        await this.loadAccounts()
        this.notify("账号已保存。", "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.saving = false
      }
    },
    async accountAction(action, account) {
      if (action === "delete" && !window.confirm(`确认删除账号「${account.label}」？`)) return
      this.busyId = account.id
      try {
        if (action === "delete") {
          await this.api(`/api/accounts/${account.id}`, { method: "DELETE" })
          this.notify("账号已删除。", "success")
        } else if (action === "toggle") {
          await this.api(`/api/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !account.enabled }) })
        } else if (action === "login") {
          this.notify(`正在登录 ${account.label}，请稍候。`)
          await this.api(`/api/accounts/${account.id}/login`, { method: "POST" })
          this.notify(`${account.label} 登录成功。`, "success")
        } else if (action === "check") {
          const result = await this.api(`/api/accounts/${account.id}/check`, { method: "POST" })
          this.notify(result.ok ? `${account.label} 会话有效。` : `${account.label} 会话不可用：${result.reason || "未知原因"}`, result.ok ? "success" : "error")
        }
        await this.loadAccounts()
      } catch (error) {
        this.notify(error.message, "error")
        await this.loadAccounts().catch(() => {})
      } finally {
        this.busyId = ""
      }
    },
    modelDisplayName(model) {
      return model.metadata?.display_name || model.id
    },
    renderModels(catalog) {
      this.modelCatalog = catalog
      this.models = Array.isArray(catalog?.data) ? catalog.data : []
    },
    async loadModels() {
      const data = await this.api("/api/models")
      this.renderModels(data.models)
    },
    async refreshModels() {
      this.refreshingModels = true
      try {
        this.notify("正在获取并保存模型目录。")
        const data = await this.api("/api/models/refresh", { method: "POST" })
        this.renderModels(data.models)
        this.notify(`已保存 ${(data.models?.data || []).length} 个可用模型。`, "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.refreshingModels = false
      }
    },
    renderGenerationDefaults(defaults) {
      this.generation = {
        temperature: Number(defaults.temperature),
        maxTokens: Number(defaults.maxTokens),
        topP: Number(defaults.topP)
      }
    },
    async loadGenerationDefaults() {
      const data = await this.api("/api/generation-defaults")
      this.renderGenerationDefaults(data.defaults)
    },
    generationDefaultsFromForm() {
      const temperature = Number(this.generation.temperature)
      const maxTokens = Number(this.generation.maxTokens)
      const topP = Number(this.generation.topP)
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new Error("Temperature 必须在 0.0 到 2.0 之间。")
      }
      if (!Number.isInteger(maxTokens) || maxTokens < 50 || maxTokens > 8150) {
        throw new Error("Max Tokens 必须是 50 到 8150 之间的整数。")
      }
      if (!Number.isFinite(topP) || topP < 0.1 || topP > 1) {
        throw new Error("Top P 必须在 0.1 到 1.0 之间。")
      }
      return { temperature, maxTokens, topP }
    },
    async saveGenerationDefaults() {
      this.savingDefaults = true
      try {
        const defaults = this.generationDefaultsFromForm()
        const data = await this.api("/api/generation-defaults", { method: "PUT", body: JSON.stringify(defaults) })
        this.renderGenerationDefaults(data.defaults)
        this.notify("全局生成参数默认值已保存。", "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.savingDefaults = false
      }
    },
    async runTest() {
      const key = this.proxyKeys.find((item) => item.enabled && item.id === this.test.keyId)
      if (!key) {
        this.test.output = "请先创建或启用一个代理 Key。"
        this.notify("请先创建或启用一个代理 Key。", "error")
        return
      }
      if (!this.test.model) {
        this.test.output = "请先获取并保存模型目录。"
        this.notify("请先获取并保存模型目录。", "error")
        return
      }
      this.test.pending = true
      this.test.output = ""
      try {
        const response = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.value}` },
          body: JSON.stringify({
            model: this.test.model.trim(),
            messages: [{ role: "user", content: this.test.message }],
            stream: true
          })
        })
        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}))
          throw new Error(typeof data.error === "string" ? data.error : data.error?.message || `请求失败（${response.status}）`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ""
        let output = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim()
            if (!data || data === "[DONE]") continue
            const chunk = JSON.parse(data)
            if (chunk.error) throw new Error(chunk.error.message || "流式请求失败")
            const delta = chunk.choices?.[0]?.delta
            if (typeof delta?.reasoning_content === "string") output += delta.reasoning_content
            if (typeof delta?.content === "string") output += delta.content
            this.test.output = output
          }
        }
        this.test.output = output
        this.notify("流式测试请求完成。", "success")
      } catch (error) {
        this.test.output = error.message
        this.notify(error.message, "error")
      } finally {
        this.test.pending = false
      }
    },
    async changePassword() {
      if (this.pwd.next.length < 8) {
        this.notify("新密码至少 8 位。", "error")
        return
      }
      if (this.pwd.next !== this.pwd.confirm) {
        this.notify("两次输入的新密码不一致。", "error")
        return
      }
      this.pwdPending = true
      try {
        await this.api("/api/admin/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword: this.pwd.current, password: this.pwd.next })
        })
        this.pwd = { current: "", next: "", confirm: "" }
        this.notify("管理员密码已更新。", "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.pwdPending = false
      }
    },
    formatDecimal(value) {
      return Number(value).toFixed(1)
    },
    formatTime(value) {
      if (!value) return "-"
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    },
    statusLabel(status) {
      return ({ unknown: "未检查", ready: "可用", expired: "已过期", login_failed: "登录失败", manual_cookie_required: "需要 Cookie" })[status] || status
    },
    statusClass(status) {
      if (status === "ready") return "status-ready"
      if (status === "login_failed" || status === "expired") return "status-error"
      if (status === "manual_cookie_required") return "status-warning"
      return "status-unknown"
    }
  },
  mounted() {
    this.bootstrap()
  }
}).mount("#app")
