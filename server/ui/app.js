const state = { proxyKeys: [], accounts: [], models: [] }

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

function managementHeaders(withBody = false) {
  const headers = {}
  if (withBody) headers["Content-Type"] = "application/json"
  return headers
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...managementHeaders(Boolean(options.body)), ...(options.headers || {}) }
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

function modelDisplayName(model) {
  return model.metadata?.display_name || model.id
}

function renderModels(catalog) {
  const models = Array.isArray(catalog?.data) ? catalog.data : []
  state.models = models
  const list = $("#model-catalog")
  const select = $("#test-model")
  list.replaceChildren()
  select.replaceChildren()

  if (models.length === 0) {
    list.className = "model-catalog empty-state"
    list.textContent = "尚未保存模型目录"
    select.append(new Option("先获取并保存模型目录", ""))
    select.disabled = true
  } else {
    list.className = "model-catalog"
    const fragment = document.createDocumentFragment()
    for (const model of models) {
      const item = document.createElement("span")
      item.className = "model-chip"
      item.textContent = model.id
      item.title = modelDisplayName(model)
      fragment.append(item)
      select.append(new Option(`${modelDisplayName(model)} (${model.id})`, model.id))
    }
    list.append(fragment)
    select.disabled = false
  }

  const fetchedAt = catalog?.fetchedAt ? formatTime(catalog.fetchedAt) : "从未获取"
  const scope = catalog?.scope || "local"
  $("#model-catalog-status").textContent = `已保存 ${models.length} 个模型 · 目录范围：${scope} · 获取时间：${fetchedAt}`
}

async function loadSavedModels() {
  const data = await api("/api/models")
  renderModels(data.models)
}

async function refreshModels() {
  const button = $("#refresh-models")
  button.disabled = true
  try {
    showNotice("正在获取并保存模型目录。")
    const data = await api("/api/models/refresh", { method: "POST" })
    renderModels(data.models)
    showNotice(`已保存 ${data.models.data.length} 个可用模型。`, "success")
  } catch (error) {
    showNotice(error.message, "error")
  } finally {
    button.disabled = false
  }
}

async function loadAccounts() {
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

const generationControlIds = {
  temperature: "generation-temperature",
  maxTokens: "generation-max-tokens",
  topP: "generation-top-p"
}

function generationDefaultsFromForm() {
  const temperature = Number($(`#${generationControlIds.temperature}`).value)
  const maxTokens = Number($(`#${generationControlIds.maxTokens}`).value)
  const topP = Number($(`#${generationControlIds.topP}`).value)

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
}

function renderGenerationDefaults(defaults) {
  for (const [name, inputId] of Object.entries(generationControlIds)) {
    const input = $(`#${inputId}`)
    const value = defaults[name]
    input.value = String(value)
    $(`#${inputId}-value`).value = name === "maxTokens" ? String(value) : Number(value).toFixed(1)
  }
}

async function loadGenerationDefaults() {
  const data = await api("/api/generation-defaults")
  renderGenerationDefaults(data.defaults)
}

async function saveGenerationDefaults(event) {
  event.preventDefault()
  const button = $("#save-generation-defaults")
  button.disabled = true
  try {
    const defaults = generationDefaultsFromForm()
    const data = await api("/api/generation-defaults", { method: "PUT", body: JSON.stringify(defaults) })
    renderGenerationDefaults(data.defaults)
    showNotice("全局生成参数默认值已保存。", "success")
  } catch (error) {
    showNotice(error.message, "error")
  } finally {
    button.disabled = false
  }
}

async function runTest(event) {
  event.preventDefault()
  const output = $("#test-output")
  const key = selectedTestKey()
  output.textContent = ""
  if (!key) {
    const message = "请先创建或启用一个代理 Key。"
    output.textContent = message
    showNotice(message, "error")
    return
  }
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.value}` },
      body: JSON.stringify({
        model: $("#test-model").value.trim(),
        messages: [{ role: "user", content: $("#test-message").value }],
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
        if (typeof delta?.reasoning_content === "string") output.textContent += delta.reasoning_content
        if (typeof delta?.content === "string") output.textContent += delta.content
        output.scrollTop = output.scrollHeight
      }
    }
    showNotice("流式测试请求完成。", "success")
  } catch (error) {
    output.textContent = error.message
    showNotice(error.message, "error")
  }
}

function selectedTestKey() {
  const select = $("#test-proxy-key")
  return state.proxyKeys.find((key) => key.enabled && key.id === select.value) || null
}

function renderTestProxyKeys() {
  const select = $("#test-proxy-key")
  const selectedId = select.value
  select.replaceChildren()
  const enabledKeys = state.proxyKeys.filter((key) => key.enabled)
  if (enabledKeys.length === 0) {
    select.append(new Option("先创建或启用代理 Key", ""))
    select.disabled = true
    return
  }

  for (const key of enabledKeys) {
    select.append(new Option(key.label, key.id))
  }
  select.value = enabledKeys.some((key) => key.id === selectedId) ? selectedId : enabledKeys[0].id
  select.disabled = false
}

function renderProxyKeys() {
  const body = $("#proxy-keys-body")
  body.replaceChildren()
  if (state.proxyKeys.length === 0) {
    const row = document.createElement("tr")
    row.innerHTML = '<td colspan="5" class="empty-state">尚未创建代理 Key</td>'
    body.append(row)
    return
  }

  for (const key of state.proxyKeys) {
    const row = document.createElement("tr")
    const labelCell = document.createElement("td")
    labelCell.textContent = key.label

    const valueCell = document.createElement("td")
    const value = document.createElement("code")
    value.className = "proxy-key-value"
    value.textContent = key.value
    valueCell.append(value)

    const statusCell = document.createElement("td")
    const badge = document.createElement("span")
    badge.className = `status-badge ${key.enabled ? "status-ready" : "status-unknown"}`
    badge.textContent = key.enabled ? "已启用" : "已禁用"
    statusCell.append(badge)

    const createdCell = document.createElement("td")
    createdCell.textContent = formatTime(key.createdAt)

    const actionsCell = document.createElement("td")
    actionsCell.className = "cell-actions"
    for (const [action, label, className] of [
      ["copy", "复制", "button-secondary"],
      ["rename", "重命名", "button-secondary"],
      ["toggle", key.enabled ? "停用" : "启用", "button-ghost"],
      ["delete", "删除", "button-danger"]
    ]) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.action = action
      button.dataset.id = key.id
      button.className = `button ${className}`
      button.textContent = label
      actionsCell.append(button)
    }

    row.append(labelCell, valueCell, statusCell, createdCell, actionsCell)
    body.append(row)
  }
}

async function loadProxyKeys() {
  const data = await api("/api/proxy-keys")
  state.proxyKeys = data.keys || []
  renderProxyKeys()
  renderTestProxyKeys()
}

async function createProxyKey(event) {
  event.preventDefault()
  const input = $("#new-proxy-key-label")
  const button = $("#proxy-key-form button[type=submit]")
  button.disabled = true
  try {
    const data = await api("/api/proxy-keys", { method: "POST", body: JSON.stringify({ label: input.value.trim() }) })
    input.value = ""
    await loadProxyKeys()
    showNotice(`已生成 Key：${data.key.label}。`, "success")
  } catch (error) {
    showNotice(error.message, "error")
  } finally {
    button.disabled = false
  }
}

async function proxyKeyAction(action, id) {
  const key = state.proxyKeys.find((item) => item.id === id)
  if (!key) return
  try {
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(key.value)
      } catch {
        const fallback = document.createElement("textarea")
        fallback.value = key.value
        fallback.readOnly = true
        fallback.style.position = "fixed"
        fallback.style.opacity = "0"
        document.body.append(fallback)
        fallback.select()
        document.execCommand("copy")
        fallback.remove()
      }
      showNotice(`${key.label} 已复制。`, "success")
      return
    }
    if (action === "rename") {
      const label = window.prompt("Key 名称", key.label)
      if (label === null) return
      await api(`/api/proxy-keys/${id}`, { method: "PATCH", body: JSON.stringify({ label }) })
    }
    if (action === "delete") {
      if (!window.confirm(`确认删除 Key“${key.label}”？此操作会立即撤销其 API 访问权限。`)) return
      await api(`/api/proxy-keys/${id}`, { method: "DELETE" })
    }
    if (action === "toggle") {
      await api(`/api/proxy-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !key.enabled }) })
    }
    await loadProxyKeys()
    const message = action === "delete"
      ? `${key.label} 已删除。`
      : action === "rename"
        ? "Key 名称已更新。"
        : `${key.label} 已${key.enabled ? "停用" : "启用"}。`
    showNotice(message, "success")
  } catch (error) {
    showNotice(error.message, "error")
  }
}

$("#refresh-accounts").addEventListener("click", () => loadAccounts().catch((error) => showNotice(error.message, "error")))
$("#refresh-models").addEventListener("click", refreshModels)
$("#clear-account-form").addEventListener("click", clearAccountForm)
$("#account-form").addEventListener("submit", saveAccount)
$("#test-form").addEventListener("submit", runTest)
$("#generation-defaults-form").addEventListener("submit", saveGenerationDefaults)
for (const inputId of Object.values(generationControlIds)) {
  $(`#${inputId}`).addEventListener("input", () => {
    const input = $(`#${inputId}`)
    const isMaxTokens = inputId === generationControlIds.maxTokens
    $(`#${inputId}-value`).value = isMaxTokens ? input.value : Number(input.value).toFixed(1)
  })
}
$("#proxy-key-form").addEventListener("submit", createProxyKey)
$("#accounts-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]")
  if (button) accountAction(button.dataset.action, button.dataset.id)
})
$("#proxy-keys-body").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]")
  if (button) proxyKeyAction(button.dataset.action, button.dataset.id)
})

checkHealth()
Promise.all([
  loadProxyKeys(),
  loadAccounts(),
  loadSavedModels(),
  loadGenerationDefaults()
]).then(() => {
  if (!selectedTestKey()) showNotice("请先生成或启用一个代理 Key 以测试 OpenAI 接口。", "error")
}).catch((error) => showNotice(error.message, "error"))
