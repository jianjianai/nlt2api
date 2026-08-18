const state = {
  page: 1,
  pageSize: 20,
  total: 0,
  traces: [],
  selectedId: "",
  detail: null,
  view: "client"
}

const $ = (selector) => document.querySelector(selector)
const historyList = $("#history-list")
const notice = $("#debug-notice")

function showNotice(message, kind = "") {
  notice.textContent = message
  notice.className = `debug-notice ${kind}`
}

function formatTime(value) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function escapeText(value) {
  if (typeof value === "string") return value
  const serialized = JSON.stringify(value, null, 2)
  return serialized === undefined ? String(value) : serialized
}

function parseBody(value) {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `请求失败（${response.status}）`)
  return data
}

function renderStatus(enabled) {
  const status = $("#debug-status")
  status.textContent = enabled ? "Debug 已开启" : "Debug 未开启"
  status.className = `status-badge ${enabled ? "status-ready" : "status-warning"}`
  $("#debug-disabled").hidden = enabled
}

function renderHistory() {
  historyList.replaceChildren()
  if (state.traces.length === 0) {
    const empty = document.createElement("p")
    empty.className = "empty-state"
    empty.textContent = state.total === 0 ? "暂无调试记录" : "这一页没有可显示的记录"
    historyList.append(empty)
  } else {
    for (const trace of state.traces) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = `history-item ${trace.id === state.selectedId ? "is-selected" : ""}`
      button.dataset.id = trace.id

      const top = document.createElement("span")
      top.className = "history-item-top"
      const model = document.createElement("strong")
      model.textContent = trace.model || "未知模型"
      const stateLabel = document.createElement("span")
      stateLabel.className = `trace-state ${trace.completed ? "is-complete" : "is-open"}`
      stateLabel.textContent = trace.completed ? "完成" : "进行中"
      top.append(model, stateLabel)

      const preview = document.createElement("span")
      preview.className = "history-preview"
      preview.textContent = trace.preview || "无用户消息预览"

      const meta = document.createElement("span")
      meta.className = "history-item-meta"
      meta.textContent = `${formatTime(trace.updatedAt)} · ${trace.upstreamAttempts} 次上游调用 · ${trace.recordCount} 条记录`
      button.append(top, preview, meta)
      historyList.append(button)
    }
  }

  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize))
  $("#history-count").textContent = `${state.total} 条请求记录`
  $("#page-indicator").textContent = `第 ${state.page} / ${totalPages} 页`
  $("#previous-page").disabled = state.page <= 1
  $("#next-page").disabled = state.page >= totalPages
}

async function loadHistory({ keepSelection = true } = {}) {
  const data = await api(`/api/debug?page=${state.page}&pageSize=${state.pageSize}`)
  state.total = data.total || 0
  state.traces = Array.isArray(data.traces) ? data.traces : []
  renderStatus(data.enabled === true)

  if (!keepSelection || !state.traces.some((trace) => trace.id === state.selectedId)) {
    state.selectedId = state.traces[0]?.id || ""
  }
  renderHistory()
  if (state.selectedId) await loadDetail(state.selectedId)
  else showEmptyDetail()
}

function showEmptyDetail() {
  $("#detail-empty").hidden = false
  $("#detail-content").hidden = true
}

async function loadDetail(id) {
  state.selectedId = id
  renderHistory()
  try {
    state.detail = await api(`/api/debug/${encodeURIComponent(id)}`)
    $("#detail-empty").hidden = true
    $("#detail-content").hidden = false
    $("#detail-title").textContent = id
    $("#detail-meta").textContent = `${formatTime(state.detail.createdAt)} · ${state.detail.records.length} 条记录`
    renderDetail()
  } catch (error) {
    showNotice(error.message, "error")
  }
}

function recordLabel(record) {
  return ({
    trace: "Trace 初始化",
    "client-request": "客户端请求",
    "upstream-request": "上游请求",
    "upstream-response": "上游响应",
    "client-response": "客户端响应"
  })[record.type] || record.type
}

function roleLabel(role) {
  return ({ system: "系统", user: "用户", assistant: "模型", tool: "工具", function: "函数" })[role] || role || "消息"
}

function isToolProtocol(value) {
  return typeof value === "string" && /<tool_calls\b|<tool_call\b/i.test(value)
}

function addCodeBlock(parent, value, className = "") {
  const pre = document.createElement("pre")
  pre.className = `record-code ${className}`
  pre.textContent = escapeText(value)
  parent.append(pre)
}

function renderMessage(parent, message, source, index) {
  if (!isObject(message)) {
    addCodeBlock(parent, message)
    return
  }
  const card = document.createElement("article")
  card.className = `message-card role-${message.role || "unknown"}`
  const header = document.createElement("header")
  header.className = "message-header"
  const role = document.createElement("span")
  role.className = "message-role"
  role.textContent = roleLabel(message.role)
  const location = document.createElement("span")
  location.className = "message-location"
  location.textContent = `${source} · ${index + 1}`
  header.append(role, location)
  card.append(header)

  if ((typeof message.reasoning_content === "string" && message.reasoning_content) || (typeof message.reasoning === "string" && message.reasoning)) {
    const thinking = document.createElement("section")
    thinking.className = "message-part thinking-part"
    const label = document.createElement("h4")
    label.textContent = "思考内容"
    thinking.append(label)
    addCodeBlock(thinking, message.reasoning_content ?? message.reasoning)
    card.append(thinking)
  }
  if (message.content !== undefined && message.content !== null && message.content !== "") {
    const content = document.createElement("section")
    content.className = "message-part"
    const label = document.createElement("h4")
    label.textContent = isToolProtocol(message.content) ? "工具调用协议" : "正文"
    content.append(label)
    addCodeBlock(content, message.content, isToolProtocol(message.content) ? "tool-protocol-code" : "")
    card.append(content)
  }
  if ((Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call !== undefined || message.tool_call_id !== undefined) {
    const tools = document.createElement("section")
    tools.className = "message-part tool-part"
    const label = document.createElement("h4")
    label.textContent = "工具调用"
    tools.append(label)
    addCodeBlock(tools, message.tool_calls ?? message.function_call ?? { tool_call_id: message.tool_call_id, content: message.content })
    card.append(tools)
  }
  if (!message.content && !message.reasoning && !message.reasoning_content && !message.tool_calls?.length && message.function_call === undefined && message.tool_call_id === undefined) {
    addCodeBlock(card, message)
  }
  parent.append(card)
}

function messagesFromRecord(record) {
  const body = parseBody(record.body)
  if (record.type === "client-request" || record.type === "upstream-request") {
    return isObject(body) && Array.isArray(body.messages) ? body.messages : []
  }
  if (record.type === "client-response" || record.type === "upstream-response") {
    if (record.metadata?.content_type?.includes?.("text/event-stream") || typeof body === "string" && body.includes("data:")) {
      return aggregateSse(body)
    }
    const response = isObject(body) ? body : {}
    const message = response.choices?.[0]?.message
    return message ? [message] : []
  }
  return []
}

function aggregateSse(value) {
  const messages = []
  const current = { role: "assistant", content: "", reasoning_content: "", tool_calls: [] }
  if (typeof value !== "string") return messages
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue
    let chunk
    try { chunk = JSON.parse(line.slice(5).trim()) } catch { continue }
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (typeof delta.content === "string") current.content += delta.content
    if (typeof delta.reasoning_content === "string") current.reasoning_content += delta.reasoning_content
    else if (typeof delta.reasoning === "string") current.reasoning_content += delta.reasoning
    if (Array.isArray(delta.tool_calls)) current.tool_calls.push(...delta.tool_calls)
  }
  if (current.content || current.reasoning_content || current.tool_calls.length) {
    if (!current.content) delete current.content
    if (!current.reasoning_content) delete current.reasoning_content
    if (current.tool_calls.length === 0) delete current.tool_calls
    messages.push(current)
  }
  return messages
}

function appendMessages(parent, record, source) {
  const messages = messagesFromRecord(record)
  if (messages.length === 0) {
    addCodeBlock(parent, parseBody(record.body))
    return
  }
  messages.forEach((message, index) => renderMessage(parent, message, source, index))
}

function renderClientView(records) {
  const container = document.createElement("div")
  container.className = "message-stack"
  for (const record of records.filter((item) => item.type === "client-request" || item.type === "client-response")) {
    const section = document.createElement("section")
    section.className = "message-group"
    const heading = document.createElement("h3")
    heading.textContent = record.type === "client-request" ? "客户端发送" : "客户端收到"
    section.append(heading)
    appendMessages(section, record, record.type === "client-request" ? "客户端请求" : "客户端响应")
    container.append(section)
  }
  return container
}

function renderUpstreamView(records) {
  const container = document.createElement("div")
  container.className = "message-stack"
  for (const record of records.filter((item) => item.type === "upstream-request" || item.type === "upstream-response")) {
    const section = document.createElement("section")
    section.className = "message-group"
    const attempt = record.metadata?.attempt ? ` · attempt ${record.metadata.attempt}` : ""
    const heading = document.createElement("h3")
    heading.textContent = `${record.type === "upstream-request" ? "发往上游" : "上游返回"}${attempt}`
    section.append(heading)
    appendMessages(section, record, record.type === "upstream-request" ? "上游请求" : "上游响应")
    container.append(section)
  }
  return container
}

function renderAllView(records) {
  const container = document.createElement("div")
  container.className = "record-stack"
  for (const record of records) {
    const article = document.createElement("article")
    article.className = "raw-record"
    const header = document.createElement("header")
    header.className = "raw-record-header"
    const title = document.createElement("strong")
    title.textContent = `${String(record.sequence).padStart(3, "0")} · ${recordLabel(record)}`
    const time = document.createElement("time")
    time.textContent = formatTime(record.recordedAt)
    header.append(title, time)
    article.append(header)
    if (record.metadata && Object.keys(record.metadata).length) {
      const metadata = document.createElement("div")
      metadata.className = "metadata-line"
      metadata.textContent = Object.entries(record.metadata).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ")
      article.append(metadata)
    }
    addCodeBlock(article, parseBody(record.body))
    container.append(article)
  }
  return container
}

function renderDetail() {
  const view = $("#detail-view")
  view.replaceChildren()
  if (!state.detail) return
  const records = state.detail.records || []
  if (state.view === "client") view.append(renderClientView(records))
  if (state.view === "upstream") view.append(renderUpstreamView(records))
  if (state.view === "all") view.append(renderAllView(records))
  for (const tab of document.querySelectorAll(".view-tab")) tab.classList.toggle("is-active", tab.dataset.view === state.view)
}

async function clearHistory() {
  if (!window.confirm("确认清空全部调试历史？此操作不可恢复。")) return
  try {
    const data = await api("/api/debug", { method: "DELETE" })
    state.page = 1
    state.selectedId = ""
    state.detail = null
    await loadHistory({ keepSelection: false })
    showNotice(`已清空 ${data.cleared || 0} 条请求记录。`, "success")
  } catch (error) {
    showNotice(error.message, "error")
  }
}

historyList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]")
  if (button) loadDetail(button.dataset.id)
})
$("#refresh-history").addEventListener("click", () => loadHistory().catch((error) => showNotice(error.message, "error")))
$("#previous-page").addEventListener("click", () => {
  if (state.page > 1) { state.page -= 1; loadHistory({ keepSelection: false }).catch((error) => showNotice(error.message, "error")) }
})
$("#next-page").addEventListener("click", () => {
  if (state.page < Math.ceil(state.total / state.pageSize)) { state.page += 1; loadHistory({ keepSelection: false }).catch((error) => showNotice(error.message, "error")) }
})
$("#clear-history").addEventListener("click", clearHistory)
$("#copy-trace-id").addEventListener("click", async () => {
  if (!state.selectedId) return
  try { await navigator.clipboard.writeText(state.selectedId); showNotice("Trace ID 已复制。", "success") } catch { showNotice("复制失败。", "error") }
})
for (const tab of document.querySelectorAll(".view-tab")) tab.addEventListener("click", () => { state.view = tab.dataset.view; renderDetail() })

loadHistory().catch((error) => showNotice(error.message, "error"))
