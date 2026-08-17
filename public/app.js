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
      accounts: [],
      editingId: "",
      form: { label: "", email: "", password: "", cookie: "" },
      saving: false,
      busyId: "",
      keyInput: "",
      keyBanner: "",
      keyPending: false,
      pwd: { current: "", next: "", confirm: "" },
      pwdPending: false,
      test: { model: "kimi-k3", message: "请只回复 TEST_OK", output: "等待测试", pending: false },
      notice: { text: "", kind: "" },
      noticeTimer: 0
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
      if (response.status === 401 && data.code === "admin_auth_required") {
        this.authed = false
        throw new Error("登录已过期，请重新登录")
      }
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
        if (this.authed) await this.loadAccounts()
      } catch {
        this.notify("无法连接服务", "error")
      }
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
        await this.loadAccounts()
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
        await this.loadAccounts()
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
      this.keyBanner = ""
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
    async loadAccounts() {
      try {
        const data = await this.api("/api/accounts")
        this.accounts = data.accounts || []
      } catch (error) {
        this.notify(error.message, "error")
      }
    },
    resetForm() {
      this.editingId = ""
      this.form = { label: "", email: "", password: "", cookie: "" }
    },
    editAccount(account) {
      this.editingId = account.id
      this.form = { label: account.label, email: account.email, password: "", cookie: "" }
    },
    async saveAccount() {
      this.saving = true
      try {
        if (this.editingId) {
          const payload = { label: this.form.label, email: this.form.email }
          if (this.form.password) payload.password = this.form.password
          await this.api(`/api/accounts/${this.editingId}`, { method: "PATCH", body: JSON.stringify(payload) })
          if (this.form.cookie) {
            await this.api(`/api/accounts/${this.editingId}/session-cookie`, { method: "POST", body: JSON.stringify({ cookie: this.form.cookie }) })
          }
          this.notify("账号已更新。", "success")
        } else {
          if (!this.form.password) {
            this.notify("新增账号必须填写密码。", "error")
            return
          }
          const data = await this.api("/api/accounts", {
            method: "POST",
            body: JSON.stringify({ label: this.form.label, email: this.form.email, password: this.form.password })
          })
          if (this.form.cookie && data.account) {
            await this.api(`/api/accounts/${data.account.id}/session-cookie`, { method: "POST", body: JSON.stringify({ cookie: this.form.cookie }) })
          }
          this.notify("账号已添加。", "success")
        }
        this.resetForm()
        await this.loadAccounts()
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
        await this.loadAccounts()
      } finally {
        this.busyId = ""
      }
    },
    async applyKey() {
      if (this.keyInput && this.keyInput.length < 8) {
        this.notify("Key 至少 8 个字符。", "error")
        return
      }
      const message = this.keyInput ? "设置后旧 Key 会立即失效，确认继续？" : "轮换后旧 Key 会立即失效，确认继续？"
      if (!window.confirm(message)) return
      this.keyPending = true
      try {
        const data = await this.api("/api/proxy-key/rotate", {
          method: "POST",
          body: JSON.stringify(this.keyInput ? { apiKey: this.keyInput } : {})
        })
        this.keyBanner = data.apiKey
        this.keyInput = ""
        this.notify("Key 已更新，请立即保存。", "success")
      } catch (error) {
        this.notify(error.message, "error")
      } finally {
        this.keyPending = false
      }
    },
    async copyKey() {
      try {
        await navigator.clipboard.writeText(this.keyBanner)
        this.notify("已复制。", "success")
      } catch {
        this.notify("复制失败，请手动选择复制。", "error")
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
    async runTest() {
      this.test.pending = true
      this.test.output = "请求中..."
      try {
        const data = await this.api("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: this.test.model, messages: [{ role: "user", content: this.test.message }], stream: false, max_tokens: 32 })
        })
        this.test.output = JSON.stringify(data, null, 2)
        this.notify("测试请求完成。", "success")
      } catch (error) {
        this.test.output = error.message
        this.notify(error.message, "error")
      } finally {
        this.test.pending = false
      }
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
