const state = { key: sessionStorage.getItem("neuralwatt-proxy-key") || "", accounts: [] }

const $ = (selector) => document.querySelector(selector)
const notice = $("#notice")

function showNotice(message, kind = "") {
  notice.textContent = message
  notice.className = `notice ${kind}`
}

function formatTime(value) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function statusLabel(status) {
  return ({
    unknown: "未检查",
    ready: "可用",
    expired: "已过期",
    login_failed: "登录失败",
    manual_cookie_required: "需要 Cookie"
  })[status] || status
}

function statusClass(status) {
  if (status === "ready") return "status-ready"
  if (status === "login_failed" || status === "expired") return "status-error"
  if (status === "manual_cookie_required") return "status-warning"
  return "status-unknown"
}

function apiHeaders(withBody = false) {
  const headers = { Authorization: `Bearer ${state.key}` }
  if (withBody) headers["Content-Type"] = "application/json"
  return headers
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...apiHeaders(Boolean(options.body)), ...(options.headers || {}) }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : data.error?.message || `请求失败（${response.status}）`)
  }
  return data
}

function setHealth(text, className) {
  const badge = $("#health-badge")
  badge.textContent = text
  badge.className = `status-badge ${className}`
}

async function checkHealth() {
  try {
    const response = await fetch("/health")
    if (!response.ok) throw new Error("health")
    setHealth("服务在线", "status-ready")
  } catch {
    setHealth("服务不可用", "status-error")
  }
}

function clearAccountForm() {
  $("#editing-id").value = ""
  $("#account-label").value = ""
  $("#account-email").value = ""
  $("#account-password").value = ""
  $("#account-cookie").value = ""
}

function renderAccounts() {
  const body = $("#accounts-body")
  body.replaceChildren()
  if (state.accounts.length === 0) {
    const row = document.createElement("tr")
    row.innerHTML = '<td colspan="5" class="empty-state">尚未配置账号</td>'
    body.append(row)
    return
  }

  for (const account of state.accounts) {
    const row = document.createElement("tr")
    const accountCell = document.createElement("td")
    accountCell.innerHTML = `<div class="account-name"></div><div class="account-email"></div>`
    accountCell.querySelector(".account-name").textContent = account.label
    accountCell.querySelector(".account-email").textContent = account.email

    const statusCell = document.createElement("td")
    const badge = document.createElement("span")
    badge.className = `status-badge ${statusClass(account.status)}`
    badge.textContent = statusLabel(account.status)
    statusCell.append(badge)

    const loginCell = document.createElement("td")
    loginCell.textContent = formatTime(account.lastLoginAt)

    const propertiesCell = document.createElement("td")
    propertiesCell.textContent = `${account.enabled ? "已启用" : "已停用"} · ${account.hasPassword ? "有密码" : "无密码"} · ${account.hasCookie ? "有会话" : "无会话"}`

    const actionsCell = document.createElement("td")
    actionsCell.className = "cell-actions"
    for (const [action, label, className] of [
      ["edit", "编辑", "button-secondary"],
      ["login", "登录", "button-primary"],
      ["check", "检查", "button-secondary"],
      ["toggle", account.enabled ? "停用" : "启用", "button-ghost"],
      ["delete", "删除", "button-danger"]
    ]) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.action = action
      button.dataset.id = account.id
      button.className = `button ${className}`
      button.textContent = label
      actionsCell.append(button)
    }

    row.append(accountCell, statusCell, loginCell, propertiesCell, actionsCell)
    body.append(row)
  }
}

async function loadAccounts() {
  if (!state.key) {
    showNotice("请先输入本地代理 Key。", "error")
    return
  }
  const data = await api("/api/accounts")
  state.accounts = data.accounts || []
  renderAccounts()
  showNotice(`已加载 ${state.accounts.length} 个账号。`, "success")
}

async function saveAccount(event) {
  event.preventDefault()
  const id = $("#editing-id").value
  const label = $("#account-label").value.trim()
  const email = $("#account-email").value.trim()
  const password = $("#account-password").value
  const cookie = $("#account-cookie").value.trim()
  if (!label || !email || (!id && !password)) {
    showNotice("新增账号必须填写名称、邮箱和密码。", "error")
    return
  }

  try {
    const data = await api(id ? `/api/accounts/${id}` : "/api/accounts", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({ label, email, password: password || undefined })
    })
    const accountId = data.account.id
    if (cookie) {
      await api(`/api/accounts/${accountId}/session-cookie`, { method: "POST", body: JSON.stringify({ cookie }) })
    }
    clearAccountForm()
    await loadAccounts()
    showNotice("账号已保存。", "success")
  } catch (error) {
    showNotice(error.message, "error")
  }
}

function editAccount(account) {
  $("#editing-id").value = account.id
  $("#account-label").value = account.label
  $("#account-email").value = account.email
  $("#account-password").value = ""
  $("#account-cookie").value = ""
  window.scrollTo({ top: 0, behavior: "smooth" })
  showNotice("编辑模式：密码留空表示保留原密码；需要替换 Cookie 时再填写。")
}

async function accountAction(action, id) {
  const account = state.accounts.find((item) => item.id === id)
  if (!account) return
  try {
    if (action === "edit") return editAccount(account)
    if (action === "delete") {
      if (!window.confirm(`确认删除账号“${account.label}”？`)) return
      await api(`/api/accounts/${id}`, { method: "DELETE" })
    }
    if (action === "toggle") {
      await api(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !account.enabled }) })
    }
    if (action === "login") {
      showNotice(`正在登录 ${account.label}，请稍候。`)
      await api(`/api/accounts/${id}/login`, { method: "POST" })
    }
    if (action === "check") {
      const result = await api(`/api/accounts/${id}/check`, { method: "POST" })
      showNotice(result.ok ? `${account.label} 会话有效。` : `${account.label} 会话不可用：${result.reason || "未知原因"}`, result.ok ? "success" : "error")
    }
    await loadAccounts()
    if (action === "login") showNotice(`${account.label} 登录成功。`, "success")
  } catch (error) {
    showNotice(error.message, "error")
    await loadAccounts().catch(() => {})
  }
}

async function runTest(event) {
  event.preventDefault()
  const output = $("#test-output")
  output.textContent = "请求中..."
  try {
    const data = await api("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: $("#test-model").value.trim(),
        messages: [{ role: "user", content: $("#test-message").value }],
        stream: false,
        max_tokens: 32
      })
    })
    output.textContent = JSON.stringify(data, null, 2)
    showNotice("测试请求完成。", "success")
  } catch (error) {
    output.textContent = error.message
    showNotice(error.message, "error")
  }
}

$("#proxy-key").value = state.key
$("#save-key").addEventListener("click", async () => {
  state.key = $("#proxy-key").value.trim()
  if (!state.key) {
    showNotice("请输入代理 Key。", "error")
    return
  }
  sessionStorage.setItem("neuralwatt-proxy-key", state.key)
  await loadAccounts().catch((error) => showNotice(error.message, "error"))
})
$("#refresh-accounts").addEventListener("click", () => loadAccounts().catch((error) => showNotice(error.message, "error")))
$("#clear-account-form").addEventListener("click", clearAccountForm)
$("#account-form").addEventListener("submit", saveAccount)
$("#test-form").addEventListener("submit", runTest)
$("#accounts-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]")
  if (button) accountAction(button.dataset.action, button.dataset.id)
})
$("#rotate-key").addEventListener("click", async () => {
  if (!state.key || !window.confirm("轮换后旧 Key 会立即失效，确认继续？")) return
  try {
    const data = await api("/api/proxy-key/rotate", { method: "POST" })
    state.key = data.apiKey
    $("#proxy-key").value = state.key
    sessionStorage.setItem("neuralwatt-proxy-key", state.key)
    showNotice("Key 已轮换，请确认已保存当前浏览器会话。", "success")
  } catch (error) {
    showNotice(error.message, "error")
  }
})

checkHealth()
if (state.key) loadAccounts().catch((error) => showNotice(error.message, "error"))
