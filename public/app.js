// ─── i18n ────────────────────────────────────────────────────────────────────

let locale = {}
let currentLang = 'fr'

async function initLocale() {
  try {
    const meta = await api('GET', '/api/locale')
    const saved = localStorage.getItem('lang')
    const browser = navigator.language.split('-')[0]
    currentLang = saved || (meta.supported.includes(browser) ? browser : meta.lang)
    const allLocales = await Promise.all(meta.supported.map((l) => api('GET', `/api/locale/${l}`)))
    locale = allLocales[meta.supported.indexOf(currentLang)]
    const labels = Object.fromEntries(meta.supported.map((l, i) => [l, allLocales[i].language_label || l]))
    renderLangSwitcher(meta.supported, labels)
  } catch {
    currentLang = 'fr'
  }
}

function t(key, vars = {}) {
  const parts = key.split('.')
  let v = locale
  for (const p of parts) {
    if (v == null || typeof v !== 'object') return key
    v = v[p]
  }
  if (typeof v !== 'string') return key
  return v.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n)
  })
}

function renderLangSwitcher(supported, labels = {}) {
  const el = document.getElementById('lang-switcher')
  if (!el) return
  el.innerHTML = supported
    .map(
      (lang) =>
        `<button class="lang-btn${lang === currentLang ? ' active' : ''}" data-lang="${lang}">${labels[lang] || lang}</button>`
    )
    .join('')
  el.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      localStorage.setItem('lang', btn.dataset.lang)
      location.reload()
    })
  })
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function api(method, url, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw Object.assign(new Error(err.error ?? 'API error'), { status: res.status })
  }
  return res.json()
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null
function showToast(msg, isError = false) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = `toast ${isError ? 'error' : 'success'}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.className = 'toast hidden'), 3500)
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function formatDuration(ms) {
  if (ms == null) return `<em>${t('transactions.in_progress')}</em>`
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

function formatEnergy(wh) {
  if (wh == null) return '—'
  return (wh / 1000).toFixed(3)
}

function renderPagination(containerId, total, page, limit, onPage) {
  const el = document.getElementById(containerId)
  if (!el) return
  const totalPages = Math.max(1, Math.ceil(total / limit))
  if (totalPages <= 1) {
    el.innerHTML = ''
    return
  }
  let html = ''
  if (page > 1) html += `<button data-page="${page - 1}">◀</button>`
  html += `<span>${page} / ${totalPages}</span>`
  if (page < totalPages) html += `<button data-page="${page + 1}">▶</button>`
  el.innerHTML = html
  el.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => onPage(+btn.dataset.page)))
}

// ─── Navigation ───────────────────────────────────────────────────────────────

let activeTab = 'status'
let activeSubtab = 'events'

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${activeTab}`))
    })
  })
  document.querySelectorAll('.sub-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSubtab = btn.dataset.subtab
      document.querySelectorAll('.sub-nav-btn').forEach((b) => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.subtab').forEach((s) => s.classList.toggle('active', s.id === `subtab-${activeSubtab}`))
    })
  })
}

// ─── Status Tab ───────────────────────────────────────────────────────────────

let cpInfo = {} // clientId → chargepoint row
let connectorMap = {} // clientId → connector status rows[]
let meterMap = {} // clientId → meter value rows[]
let activeFaultCount = {} // clientId → count
let onlineClients = new Set() // clientIds currently connected to proxy
let configuredClientIds = new Set() // clientIds present in config.routing
let upstreamStatusMap = {} // clientId → { pri: bool, sec: bool|null }

const STATUS_COLOR = {
  Available: 'status-available',
  Charging: 'status-charging',
  Preparing: 'status-preparing',
  SuspendedEVSE: 'status-suspended',
  SuspendedEV: 'status-suspended',
  Finishing: 'status-finishing',
  Reserved: 'status-reserved',
  Unavailable: 'status-unavailable',
  Faulted: 'status-faulted',
}

async function loadStatus() {
  const [statusRows, cpRows, meterRows, faultData, connectedIds, cfg] = await Promise.all([
    api('GET', '/api/status'),
    api('GET', '/api/chargepoints'),
    api('GET', '/api/meters'),
    api('GET', '/api/faults?cleared=0&limit=1000'),
    api('GET', '/api/connected'),
    api('GET', '/api/config'),
  ])

  onlineClients = new Set(connectedIds)
  configuredClientIds = new Set(Object.keys(cfg.routing ?? {}).filter((k) => k !== 'default'))

  cpInfo = {}
  for (const cp of cpRows) cpInfo[cp.client_id] = cp

  connectorMap = {}
  for (const row of statusRows) {
    ;(connectorMap[row.client_id] ??= []).push(row)
  }

  meterMap = {}
  for (const mv of meterRows) {
    ;(meterMap[mv.client_id] ??= []).push(mv)
  }

  activeFaultCount = {}
  for (const row of faultData.rows) {
    activeFaultCount[row.client_id] = (activeFaultCount[row.client_id] ?? 0) + 1
  }

  renderStatusGrid()
}

async function loadUpstreamStatus() {
  try {
    upstreamStatusMap = await api('GET', '/api/upstream-status')
  } catch {}
}

function renderStatusGrid() {
  const grid = document.getElementById('status-grid')
  if (!grid) return

  const clientIds = [...new Set([...Object.keys(connectorMap), ...Object.keys(cpInfo)])].sort()

  if (clientIds.length === 0) {
    grid.innerHTML = '<p class="empty-state">Aucune borne connectée.</p>'
    return
  }

  grid.innerHTML = clientIds.map(renderCPCard).join('')

  // Name form
  grid.querySelectorAll('.cp-name-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const clientId = form.dataset.clientId
      const name = form.querySelector('input').value.trim() || null
      try {
        await api('PUT', `/api/chargepoints/${encodeURIComponent(clientId)}/name`, { name })
        if (cpInfo[clientId]) cpInfo[clientId].name = name
        showToast(t('toast.saved'))
      } catch {
        showToast(t('toast.error'), true)
      }
    })
  })

  // Commands toggle
  grid.querySelectorAll('.commands-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.cp-card').querySelector('.commands-panel').classList.toggle('open')
    })
  })

  // Fault badge → inline list
  grid.querySelectorAll('.fault-badge').forEach((badge) => {
    badge.addEventListener('click', async () => {
      const clientId = badge.dataset.clientId
      const panel = badge.closest('.cp-card').querySelector('.faults-inline')
      if (panel.classList.contains('open')) {
        panel.classList.remove('open')
        panel.innerHTML = ''
        return
      }
      panel.classList.add('open')
      panel.innerHTML = '<p style="padding:.4rem">…</p>'
      try {
        const data = await api('GET', `/api/faults?clientId=${encodeURIComponent(clientId)}&cleared=0&limit=10`)
        panel.innerHTML = renderInlineFaults(data.rows)
      } catch {
        panel.innerHTML = `<p style="color:var(--danger);padding:.4rem">${t('toast.error')}</p>`
      }
    })
  })

  // Delete chargepoint
  grid.querySelectorAll('.cp-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteChargepoint(btn.dataset.clientId))
  })

  setupCommandPanels(grid)
}

function renderCPCard(clientId) {
  const cp = cpInfo[clientId] ?? {}
  const connectors = connectorMap[clientId] ?? []
  const meters = meterMap[clientId] ?? []
  const faultCount = activeFaultCount[clientId] ?? 0

  const isOnline = onlineClients.has(clientId)
  const onlineBadge = `<span class="cp-online-badge ${isOnline ? 'online' : 'offline'}" data-client-id="${esc(clientId)}">${esc(isOnline ? t('chargepoint.online') : t('chargepoint.offline'))}</span>`

  const upSt = upstreamStatusMap[clientId]
  const upstreamBadges = upSt !== undefined
    ? `<span class="upstream-badge ${upSt.pri ? 'connected' : 'disconnected'}" data-upstream-name="PRI" data-upstream-configured="true" title="${esc(t('chargepoint.upstream_pri'))}">PRI</span>` +
      `<span class="upstream-badge ${upSt.sec === null ? 'unconfigured' : upSt.sec ? 'connected' : 'disconnected'}" data-upstream-name="SEC" data-upstream-configured="${upSt.sec !== null}" title="${esc(upSt.sec === null ? t('chargepoint.upstream_unconfigured') : t('chargepoint.upstream_sec'))}">SEC</span>`
    : ''

  const faultBadge =
    faultCount > 0
      ? `<button class="fault-badge" data-client-id="${esc(clientId)}" title="${esc(t('faults.active_faults', { count: faultCount }))}">⚠ ${faultCount}</button>`
      : ''

  const deleteBtn =
    !isOnline && !configuredClientIds.has(clientId)
      ? `<button class="btn-danger btn-sm cp-delete-btn" data-client-id="${esc(clientId)}">${esc(t('action.delete'))}</button>`
      : ''

  const meta = [
    cp.vendor ? `${esc(t('chargepoint.vendor'))}: ${esc(cp.vendor)}` : '',
    cp.model ? `${esc(t('chargepoint.model'))}: ${esc(cp.model)}` : '',
    cp.last_seen ? `${esc(t('chargepoint.last_seen'))}: ${formatTs(cp.last_seen)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const routing = configData?.routing ?? {}
  const routeUrls = routing[clientId] ?? routing['default'] ?? []
  const routeTitle = (Array.isArray(routeUrls) ? routeUrls : [routeUrls]).join(' · ')
  const isCustomRoute = configuredClientIds.has(clientId)
  const routeBadge = `<span class="cp-route-badge ${isCustomRoute ? 'route-custom' : 'route-default'}" title="${esc(routeTitle)}">${esc(isCustomRoute ? t('chargepoint.route_custom') : t('chargepoint.route_default'))}</span>`

  const badges = connectors.map((c) => renderConnectorBadge(c, meters)).join('')

  return `
    <div class="cp-card${isOnline ? '' : ' offline'}" data-client-id="${esc(clientId)}">
      <div class="cp-header">
        <div class="cp-title">
          <form class="cp-name-form" data-client-id="${esc(clientId)}">
            <input type="text" value="${esc(cp.name ?? '')}" placeholder="${esc(t('chargepoint.name_placeholder'))}" class="cp-name-input">
            <button type="submit" class="btn-sm">${esc(t('action.save'))}</button>
          </form>
          <span class="cp-id">${esc(clientId)}</span>
        </div>
        <div class="cp-actions">
          ${onlineBadge}
          ${upstreamBadges}
          ${faultBadge}
          ${deleteBtn}
          <button class="commands-toggle btn-sm"${isOnline ? '' : ' disabled'}>${esc(t('commands.title'))}</button>
        </div>
      </div>
      <div class="cp-meta">${meta ? `<span>${meta}</span>` : ''}${routeBadge}</div>
      <div class="connectors-row">${badges || '<span class="empty-state">—</span>'}</div>
      <div class="faults-inline"></div>
      <div class="commands-panel">${renderCommandPanel(clientId)}</div>
    </div>`
}

async function deleteChargepoint(clientId) {
  if (!confirm(t('chargepoint.delete_confirm', { id: clientId }))) return
  try {
    await api('DELETE', `/api/chargepoints/${encodeURIComponent(clientId)}`)
    delete cpInfo[clientId]
    delete connectorMap[clientId]
    delete meterMap[clientId]
    delete activeFaultCount[clientId]
    renderStatusGrid()
    showToast(t('toast.deleted'))
  } catch {
    showToast(t('toast.error'), true)
  }
}

function renderConnectorBadge(c, meters) {
  const label = c.is_station
    ? t('connector.station')
    : c.evse_id > 0
      ? `${t('connector.evse_label', { id: c.evse_id })} C${c.connector_id}`
      : t('connector.label', { id: c.connector_id })

  const colorClass = STATUS_COLOR[c.status] ?? 'status-unknown'
  const statusLabel = t(`status.${c.status}`) || c.status

  const connMeters = meters.filter((m) => m.evse_id === c.evse_id && m.connector_id === c.connector_id)
  const metersHtml = connMeters
    .map(
      (m) =>
        `<span class="meter-val">${esc(m.measurand.split('.').pop())}: ${esc(Number(m.value).toFixed(1))} ${esc(m.unit ?? '')}</span>`
    )
    .join('')

  return `
    <div class="connector-badge ${colorClass}"
         data-client-id="${esc(c.client_id)}"
         data-evse-id="${esc(c.evse_id)}"
         data-connector-id="${esc(c.connector_id)}">
      <div class="connector-label">${esc(label)}</div>
      <div class="connector-status">${esc(statusLabel)}</div>
      ${metersHtml ? `<div class="connector-meters">${metersHtml}</div>` : ''}
    </div>`
}

function renderInlineFaults(rows) {
  if (!rows.length) return `<p style="padding:.4rem;color:var(--text-muted)">${t('faults.no_results')}</p>`
  return `<table class="inline-faults-table">
    <thead><tr>
      <th>${t('faults.col_time')}</th>
      <th>${t('faults.col_component')}</th>
      <th>${t('faults.col_error_code')}</th>
      <th>${t('faults.col_severity')}</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <td>${formatTs(r.ts)}</td>
      <td>${esc(r.component ?? '—')}</td>
      <td>${esc(r.error_code ?? '—')}</td>
      <td>${r.severity ?? '—'}</td>
    </tr>`
      )
      .join('')}</tbody>
  </table>`
}

// ─── Commands Panel ───────────────────────────────────────────────────────────

function renderCommandPanel(clientId) {
  return `
    <div class="cmd-form" data-client-id="${esc(clientId)}">
      <select class="cmd-select">
        <option value="reset">${esc(t('commands.reset'))}</option>
        <option value="unlock">${esc(t('commands.unlock'))}</option>
        <option value="trigger">${esc(t('commands.trigger'))}</option>
        <option value="diagnostics">${esc(t('commands.get_diagnostics'))}</option>
        <option value="get-config">${esc(t('commands.get_config'))}</option>
      </select>
      <div class="cmd-params"></div>
      <button class="cmd-send btn-primary">${esc(t('commands.send'))}</button>
      <div class="cmd-result"></div>
    </div>`
}

const CMD_FIELDS = {
  reset: () =>
    `<label>${esc(t('commands.reset_type'))}: <select name="type"><option value="Soft">Soft</option><option value="Hard">Hard</option></select></label>`,
  unlock: () =>
    `<label>${esc(t('commands.connector_id'))}: <input type="number" name="connectorId" value="1" min="1" style="width:70px"></label>`,
  trigger: () =>
    `<label>${esc(t('commands.message_type'))}: <select name="message">
      <option>BootNotification</option><option>StatusNotification</option>
      <option>Heartbeat</option><option>MeterValues</option>
      <option>DiagnosticsStatusNotification</option>
    </select></label>`,
  diagnostics: () =>
    `<label>${esc(t('commands.upload_location'))}: <input type="text" name="location" placeholder="ftp://..." style="width:220px"></label>`,
  'get-config': () =>
    `<label>${esc(t('commands.keys'))}: <input type="text" name="keys" placeholder="Key1,Key2" style="width:200px"></label>`,
}

function setupCommandPanels(container) {
  container.querySelectorAll('.cmd-form').forEach((form) => {
    const sel = form.querySelector('.cmd-select')
    const paramsDiv = form.querySelector('.cmd-params')
    const resultDiv = form.querySelector('.cmd-result')
    const sendBtn = form.querySelector('.cmd-send')
    const clientId = form.dataset.clientId

    const updateParams = () => {
      paramsDiv.innerHTML = CMD_FIELDS[sel.value]?.() ?? ''
    }
    updateParams()
    sel.addEventListener('change', updateParams)

    sendBtn.addEventListener('click', async () => {
      const action = sel.value
      const body = {}
      paramsDiv.querySelectorAll('[name]').forEach((input) => {
        body[input.name] = input.value
      })
      if (action === 'get-config' && body.keys) {
        body.keys = body.keys
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
      }
      if (action === 'unlock') body.connectorId = +body.connectorId

      sendBtn.disabled = true
      resultDiv.textContent = '…'

      try {
        const result = await api('POST', `/api/commands/${encodeURIComponent(clientId)}/${action}`, body)
        resultDiv.innerHTML = `<span class="result-ok">${esc(result.status)} — ${esc(JSON.stringify(result.result))}</span>`
      } catch (err) {
        const msg =
          err.status === 404 ? t('commands.not_connected') : err.status === 408 ? t('commands.timeout') : t('toast.error')
        resultDiv.innerHTML = `<span class="result-err">${esc(msg)}</span>`
      } finally {
        sendBtn.disabled = false
      }
    })
  })
}

// ─── Events Tab ───────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  'connected_proxy',
  'disconnected_proxy',
  'connected_upstream',
  'disconnected_upstream',
  'status_notification',
  'start_transaction',
  'stop_transaction',
  'transaction_event',
  'authorize',
  'boot_notification',
]

let eventPage = 1
let eventFilters = { type: '', clientId: '' }

function setupEventsFilters() {
  const typeEl = document.getElementById('events-type-filter')
  const clientEl = document.getElementById('events-client-filter')

  typeEl.innerHTML =
    `<option value="">${t('events.all_types')}</option>` +
    EVENT_TYPES.map((tp) => `<option value="${tp}">${tp}</option>`).join('')

  clientEl.innerHTML =
    `<option value="">${t('events.all_clients')}</option>` +
    Object.keys(cpInfo)
      .sort()
      .map((id) => `<option value="${esc(id)}">${esc(cpInfo[id]?.name || id)}</option>`)
      .join('')

  typeEl.value = eventFilters.type
  clientEl.value = eventFilters.clientId

  typeEl.addEventListener('change', () => {
    eventFilters.type = typeEl.value
    eventPage = 1
    loadEvents()
  })
  clientEl.addEventListener('change', () => {
    eventFilters.clientId = clientEl.value
    eventPage = 1
    loadEvents()
  })
}

async function loadEvents() {
  const p = new URLSearchParams({ page: eventPage, limit: 50 })
  if (eventFilters.type) p.set('type', eventFilters.type)
  if (eventFilters.clientId) p.set('clientId', eventFilters.clientId)
  const data = await api('GET', `/api/events?${p}`)
  renderEventsTable(data)
}

function renderEventsTable({ rows, total, page, limit }) {
  const tbody = document.getElementById('events-tbody')
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${formatTs(r.ts)}</td>
        <td><span class="event-type">${esc(r.type)}</span></td>
        <td>${esc(cpInfo[r.client_id]?.name || r.client_id)}</td>
        <td>${r.connector_id != null ? esc(r.connector_id) : '—'}</td>
        <td>${r.payload ? `<details><summary>…</summary><pre>${esc(JSON.stringify(JSON.parse(r.payload), null, 2))}</pre></details>` : '—'}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="empty">${t('events.no_results')}</td></tr>`
  renderPagination('events-pagination', total, page, limit, (pg) => {
    eventPage = pg
    loadEvents()
  })
}

// ─── Faults Tab ───────────────────────────────────────────────────────────────

let faultPage = 1
let faultFilters = { clientId: '', cleared: '' }

function setupFaultsFilters() {
  const clientEl = document.getElementById('faults-client-filter')
  const clearedEl = document.getElementById('faults-cleared-filter')

  clientEl.innerHTML =
    `<option value="">${t('faults.all_clients')}</option>` +
    Object.keys(cpInfo)
      .sort()
      .map((id) => `<option value="${esc(id)}">${esc(cpInfo[id]?.name || id)}</option>`)
      .join('')

  clearedEl.innerHTML = `
    <option value="">${t('faults.all')}</option>
    <option value="0">${t('faults.active_only')}</option>`

  clientEl.value = faultFilters.clientId
  clearedEl.value = faultFilters.cleared

  clientEl.addEventListener('change', () => {
    faultFilters.clientId = clientEl.value
    faultPage = 1
    loadFaults()
  })
  clearedEl.addEventListener('change', () => {
    faultFilters.cleared = clearedEl.value
    faultPage = 1
    loadFaults()
  })
}

async function loadFaults() {
  const p = new URLSearchParams({ page: faultPage, limit: 50 })
  if (faultFilters.clientId) p.set('clientId', faultFilters.clientId)
  if (faultFilters.cleared !== '') p.set('cleared', faultFilters.cleared)
  const data = await api('GET', `/api/faults?${p}`)
  renderFaultsTable(data)
}

function renderFaultsTable({ rows, total, page, limit }) {
  const tbody = document.getElementById('faults-tbody')
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${formatTs(r.ts)}</td>
        <td>${esc(cpInfo[r.client_id]?.name || r.client_id)}</td>
        <td>${esc(r.component ?? '—')}</td>
        <td>${esc(r.error_code ?? '—')}</td>
        <td>${r.severity ?? '—'}</td>
        <td>${esc(r.info ?? '—')}</td>
        <td>${esc(r.vendor_id ?? '—')}</td>
        <td>${r.cleared ? '✓' : '✗'}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="8" class="empty">${t('faults.no_results')}</td></tr>`
  renderPagination('faults-pagination', total, page, limit, (pg) => {
    faultPage = pg
    loadFaults()
  })
}

// ─── Transactions Tab ─────────────────────────────────────────────────────────

let txPage = 1
let txFilters = { clientId: '' }

function setupTxFilters() {
  const clientEl = document.getElementById('tx-client-filter')
  clientEl.innerHTML =
    `<option value="">${t('transactions.all_clients')}</option>` +
    Object.keys(cpInfo)
      .sort()
      .map((id) => `<option value="${esc(id)}">${esc(cpInfo[id]?.name || id)}</option>`)
      .join('')
  clientEl.value = txFilters.clientId
  clientEl.addEventListener('change', () => {
    txFilters.clientId = clientEl.value
    txPage = 1
    loadTransactions()
  })
}

async function loadTransactions() {
  const p = new URLSearchParams({ page: txPage, limit: 50 })
  if (txFilters.clientId) p.set('clientId', txFilters.clientId)
  const data = await api('GET', `/api/transactions?${p}`)
  renderTxTable(data)
}

function renderTxTable({ rows, total, page, limit }) {
  const tbody = document.getElementById('tx-tbody')
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${esc(r.name || r.client_id)}</td>
        <td>${esc(r.connector_id)}</td>
        <td>${esc(r.id_tag ?? '—')}</td>
        <td>${formatTs(r.started_at)}</td>
        <td>${r.stopped_at ? formatTs(r.stopped_at) : `<em>${t('transactions.in_progress')}</em>`}</td>
        <td>${formatDuration(r.duration_ms)}</td>
        <td>${formatEnergy(r.energy_wh)}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="empty">${t('transactions.no_results')}</td></tr>`
  renderPagination('tx-pagination', total, page, limit, (pg) => {
    txPage = pg
    loadTransactions()
  })
}

// ─── Config Tab ───────────────────────────────────────────────────────────────

let configData = null

async function loadConfig() {
  configData = await api('GET', '/api/config')
  configuredClientIds = new Set(Object.keys(configData.routing ?? {}).filter((k) => k !== 'default'))
  renderConfig(configData)
}

function renderConfig(cfg) {
  const container = document.getElementById('config-container')
  if (!container) return

  const n = cfg.notify ?? {}
  const em = n.email ?? {}
  const po = n.pushover ?? {}

  container.innerHTML = `
    <div class="config-section">
      <h3>${t('config.section_notify')}</h3>
      <div class="notify-toggles">
        ${toggle('onConnect', n.onConnect, t('config.notify_on_connect'))}
        ${toggle('onDisconnect', n.onDisconnect, t('config.notify_on_disconnect'))}
        ${toggle('onUpstreamConnect', n.onUpstreamConnect, t('config.notify_on_upstream_connect'))}
        ${toggle('onUpstreamDisconnect', n.onUpstreamDisconnect, t('config.notify_on_upstream_disconnect'))}
        ${toggle('onStatusFault', n.onStatusFault, t('config.notify_on_fault'))}
        ${toggle('onTransaction', n.onTransaction, t('config.notify_on_transaction'))}
      </div>
      <button class="btn-primary" id="save-notify">${t('action.save')}</button>
    </div>

    <div class="config-section">
      <h3>${t('config.section_routing')}</h3>
      <div id="routing-wrap">${renderRoutingTable(cfg.routing ?? {})}</div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn-secondary" id="add-route">${t('action.add_rule')}</button>
        <button class="btn-primary"   id="save-routing">${t('action.save')}</button>
      </div>
    </div>

    <div class="config-section">
      <h3>${t('config.section_email')}</h3>
      ${toggle('email_enabled', em.enabled, t('config.email_enabled'))}
      <div class="form-field">
        <label>${esc(t('config.email_mode'))}</label>
        <select id="email-mode">
          <option value="smtp"    ${emailMode(em) === 'smtp' ? 'selected' : ''}>${esc(t('config.email_mode_smtp'))}</option>
          <option value="service" ${emailMode(em) === 'service' ? 'selected' : ''}>${esc(t('config.email_mode_service'))}</option>
          <option value="sendmail"${emailMode(em) === 'sendmail' ? 'selected' : ''}>${esc(t('config.email_mode_sendmail'))}</option>
        </select>
      </div>
      ${field('email_from', em.from ?? '', t('config.email_from'))}
      ${field('email_to', em.to ?? '', t('config.email_to'))}
      <div id="email-transport-fields">${renderEmailTransportFields(emailMode(em), em.transport)}</div>
      <button class="btn-primary" id="save-email">${t('action.save')}</button>
    </div>

    <div class="config-section">
      <h3>${t('config.section_pushover')}</h3>
      ${toggle('pushover_enabled', po.enabled, t('config.pushover_enabled'))}
      ${field('pushover_token', po.token ?? '', t('config.pushover_token'))}
      ${field('pushover_user', po.user ?? '', t('config.pushover_user'))}
      <button class="btn-primary" id="save-pushover">${t('action.save')}</button>
    </div>`

  setupConfigHandlers(cfg)
}

function toggle(name, checked, label) {
  return `<label class="toggle-label">
    <input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}>
    ${esc(label)}
  </label>`
}

function field(name, value, label, type = 'text') {
  return `<div class="form-field">
    <label>${esc(label)}</label>
    <input type="${type}" name="${esc(name)}" value="${esc(value)}">
  </div>`
}

function emailMode(em) {
  const tr = em?.transport ?? {}
  if (tr.sendmail) return 'sendmail'
  if (tr.service) return 'service'
  return 'smtp'
}

function renderEmailTransportFields(mode, tr) {
  tr = tr ?? {}
  if (mode === 'service') {
    return `
      <div class="form-field">
        <label>${esc(t('config.email_service_name'))}</label>
        <input type="text" name="email_t_service" value="${esc(tr.service ?? '')}" list="email-services">
        <datalist id="email-services">
          <option value="Gmail"><option value="Outlook"><option value="Hotmail">
          <option value="Yahoo"><option value="SendGrid"><option value="Mailgun">
        </datalist>
      </div>
      ${field('email_t_user', tr.auth?.user ?? '', t('config.email_user'))}
      ${field('email_t_pass', tr.auth?.pass ?? '', t('config.email_pass'), 'password')}`
  }
  if (mode === 'sendmail') {
    return field('email_t_path', tr.path ?? '/usr/sbin/sendmail', t('config.email_sendmail_path'))
  }
  return `
    ${field('email_t_host', tr.host ?? '', t('config.email_smtp_host'))}
    ${field('email_t_port', tr.port ?? 587, t('config.email_port'), 'number')}
    ${toggle('email_t_secure', tr.secure ?? false, t('config.email_smtp_secure'))}
    ${field('email_t_user', tr.auth?.user ?? '', t('config.email_user'))}
    ${field('email_t_pass', tr.auth?.pass ?? '', t('config.email_pass'), 'password')}`
}

function renderRoutingTable(routing) {
  const rows = Object.entries(routing)
    .map(([clientId, urls]) => {
      const isDefault = clientId === 'default'
      const clientCell = isDefault
        ? `<em>${t('config.routing_default_label')}</em> <small>${t('config.routing_default_hint')}</small>`
        : `<input type="text" class="routing-client" value="${esc(clientId)}">`
      const urlVal = Array.isArray(urls) ? urls.join(', ') : String(urls)
      return `<tr data-client="${esc(clientId)}">
      <td>${clientCell}</td>
      <td><input type="text" class="routing-url" value="${esc(urlVal)}"></td>
      <td>${!isDefault ? `<button class="btn-danger routing-delete">${t('action.delete')}</button>` : ''}</td>
    </tr>`
    })
    .join('')

  return `<table class="routing-table">
    <thead><tr>
      <th>${t('config.routing_client')}</th>
      <th>${t('config.routing_upstream')}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function setupConfigHandlers(cfg) {
  // Notify toggles
  document.getElementById('save-notify')?.addEventListener('click', async () => {
    const body = {}
    document.querySelectorAll('.notify-toggles input[type=checkbox]').forEach((cb) => (body[cb.name] = cb.checked))
    try {
      await api('PUT', '/api/config/notify', body)
      Object.assign(cfg.notify, body)
      showToast(t('toast.saved'))
    } catch {
      showToast(t('toast.error'), true)
    }
  })

  // Email — mode switch
  document.getElementById('email-mode')?.addEventListener('change', (e) => {
    document.getElementById('email-transport-fields').innerHTML = renderEmailTransportFields(e.target.value, {})
  })

  // Email — save
  document.getElementById('save-email')?.addEventListener('click', async () => {
    const get = (name) => document.querySelector(`[name="${name}"]`)
    const val = (name) => get(name)?.value ?? ''
    const chk = (name) => get(name)?.checked ?? false
    const mode = document.getElementById('email-mode').value

    let transport
    if (mode === 'service') {
      transport = { service: val('email_t_service'), auth: { user: val('email_t_user'), pass: val('email_t_pass') } }
    } else if (mode === 'sendmail') {
      transport = { sendmail: true, path: val('email_t_path') }
    } else {
      transport = {
        host: val('email_t_host'),
        port: +val('email_t_port') || 587,
        secure: chk('email_t_secure'),
        auth: { user: val('email_t_user'), pass: val('email_t_pass') },
      }
    }

    const body = { enabled: chk('email_enabled'), from: val('email_from'), to: val('email_to'), transport }
    try {
      await api('PUT', '/api/config/email', body)
      showToast(t('toast.saved'))
    } catch {
      showToast(t('toast.error'), true)
    }
  })

  // Pushover
  document.getElementById('save-pushover')?.addEventListener('click', async () => {
    const body = {}
    document.querySelectorAll('[name^="pushover_"]').forEach((input) => {
      const key = input.name.replace('pushover_', '')
      body[key] = input.type === 'checkbox' ? input.checked : input.value
    })
    try {
      await api('PUT', '/api/config/pushover', body)
      showToast(t('toast.saved'))
    } catch {
      showToast(t('toast.error'), true)
    }
  })

  // Routing — add row
  document.getElementById('add-route')?.addEventListener('click', () => {
    const tbody = document.querySelector('.routing-table tbody')
    if (!tbody) return
    const tr = document.createElement('tr')
    tr.dataset.client = ''
    tr.innerHTML = `
      <td><input type="text" class="routing-client" placeholder="${esc(t('config.routing_client'))}"></td>
      <td><input type="text" class="routing-url" placeholder="ws://..."></td>
      <td><button class="btn-danger routing-delete">${t('action.delete')}</button></td>`
    tbody.appendChild(tr)
    bindDeleteButtons()
  })

  bindDeleteButtons()

  // Routing — save
  document.getElementById('save-routing')?.addEventListener('click', async () => {
    const routing = {}
    document.querySelectorAll('.routing-table tbody tr').forEach((tr) => {
      const clientInput = tr.querySelector('.routing-client')
      const urlInput = tr.querySelector('.routing-url')
      if (!urlInput) return
      const id = clientInput ? clientInput.value.trim() : tr.dataset.client
      const urls = urlInput.value.trim()
      if (!id || !urls) return
      routing[id] = urls
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    })
    if (!routing.default) {
      showToast('default routing entry required', true)
      return
    }
    try {
      await api('PUT', '/api/config/routing', routing)
      configData.routing = routing
      configuredClientIds = new Set(Object.keys(routing).filter((k) => k !== 'default'))
      renderStatusGrid()
      showToast(t('toast.saved'))
    } catch {
      showToast(t('toast.error'), true)
    }
  })
}

function bindDeleteButtons() {
  document.querySelectorAll('.routing-delete').forEach((btn) => {
    btn.onclick = () => btn.closest('tr').remove()
  })
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function initSSE() {
  const es = new EventSource('/api/events/stream')

  es.addEventListener('status-update', (e) => {
    const { clientId, evseId, connectorId, status } = JSON.parse(e.data)
    const badge = document.querySelector(
      `.connector-badge[data-client-id="${clientId}"][data-evse-id="${evseId}"][data-connector-id="${connectorId}"]`
    )
    if (badge) {
      badge.className = `connector-badge ${STATUS_COLOR[status] ?? 'status-unknown'}`
      const el = badge.querySelector('.connector-status')
      if (el) el.textContent = t(`status.${status}`) || status
    } else {
      loadStatus()
    }
    const arr = connectorMap[clientId]
    if (arr) {
      const c = arr.find((x) => x.evse_id === evseId && x.connector_id === connectorId)
      if (c) c.status = status
    }
  })

  es.addEventListener('fault-event', (e) => {
    const fault = JSON.parse(e.data)
    const clientId = fault.clientId
    if (!fault.cleared) activeFaultCount[clientId] = (activeFaultCount[clientId] ?? 0) + 1

    const card = document.querySelector(`.cp-card[data-client-id="${clientId}"]`)
    if (card) {
      const count = activeFaultCount[clientId] ?? 0
      let badge = card.querySelector('.fault-badge')
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('button')
          badge.className = 'fault-badge'
          badge.dataset.clientId = clientId
          badge.addEventListener('click', async () => {
            const panel = card.querySelector('.faults-inline')
            if (panel.classList.contains('open')) {
              panel.classList.remove('open')
              panel.innerHTML = ''
              return
            }
            panel.classList.add('open')
            panel.innerHTML = '<p style="padding:.4rem">…</p>'
            try {
              const data = await api('GET', `/api/faults?clientId=${encodeURIComponent(clientId)}&cleared=0&limit=10`)
              panel.innerHTML = renderInlineFaults(data.rows)
            } catch {
              panel.innerHTML = `<p style="color:var(--danger);padding:.4rem">${t('toast.error')}</p>`
            }
          })
          card.querySelector('.cp-actions').prepend(badge)
        }
        badge.textContent = `⚠ ${count}`
        badge.title = t('faults.active_faults', { count })
      }
    }
    if (activeTab === 'events' && activeSubtab === 'faults') loadFaults()
  })

  es.addEventListener('fault-cleared', (e) => {
    const { clientId } = JSON.parse(e.data)
    activeFaultCount[clientId] = 0
    const card = document.querySelector(`.cp-card[data-client-id="${clientId}"]`)
    if (card) {
      const badge = card.querySelector('.fault-badge')
      if (badge) badge.remove()
      const panel = card.querySelector('.faults-inline')
      if (panel) {
        panel.classList.remove('open')
        panel.innerHTML = ''
      }
    }
    if (activeTab === 'events' && activeSubtab === 'faults') loadFaults()
  })

  es.addEventListener('client-connected', (e) => {
    const { clientId } = JSON.parse(e.data)
    onlineClients.add(clientId)
    const badge = document.querySelector(`.cp-online-badge[data-client-id="${clientId}"]`)
    if (badge) {
      badge.className = 'cp-online-badge online'
      badge.textContent = t('chargepoint.online')
      const card = badge.closest('.cp-card')
      if (card) {
        card.classList.remove('offline')
        const cmdBtn = card.querySelector('.commands-toggle')
        if (cmdBtn) cmdBtn.disabled = false
        card.querySelector('.cp-delete-btn')?.remove()
      }
    } else {
      loadStatus()
    }
  })

  es.addEventListener('client-disconnected', (e) => {
    const { clientId } = JSON.parse(e.data)
    onlineClients.delete(clientId)
    const badge = document.querySelector(`.cp-online-badge[data-client-id="${clientId}"]`)
    if (badge) {
      badge.className = 'cp-online-badge offline'
      badge.textContent = t('chargepoint.offline')
      if (!configuredClientIds.has(clientId)) {
        const card = badge.closest('.cp-card')
        const actionsEl = card?.querySelector('.cp-actions')
        if (actionsEl && !actionsEl.querySelector('.cp-delete-btn')) {
          const btn = document.createElement('button')
          btn.className = 'btn-danger btn-sm cp-delete-btn'
          btn.dataset.clientId = clientId
          btn.textContent = t('action.delete')
          btn.addEventListener('click', () => deleteChargepoint(clientId))
          actionsEl.querySelector('.commands-toggle').before(btn)
        }
      }
    }
    const prevStatus = upstreamStatusMap[clientId]
    delete upstreamStatusMap[clientId]
    const card = document.querySelector(`.cp-card[data-client-id="${clientId}"]`)
    if (card) {
      card.classList.add('offline')
      const cmdBtn = card.querySelector('.commands-toggle')
      if (cmdBtn) cmdBtn.disabled = true
      if (prevStatus) {
        const pri = card.querySelector('.upstream-badge[data-upstream-name="PRI"]')
        if (pri) pri.className = 'upstream-badge disconnected'
        const sec = card.querySelector('.upstream-badge[data-upstream-name="SEC"]')
        if (sec && sec.dataset.upstreamConfigured === 'true') sec.className = 'upstream-badge disconnected'
      }
    }
  })

  es.addEventListener('upstream-update', (e) => {
    const { clientId, name, connected } = JSON.parse(e.data)
    if (!upstreamStatusMap[clientId]) upstreamStatusMap[clientId] = { pri: false, sec: null }
    if (name === 'PRI') upstreamStatusMap[clientId].pri = connected
    else if (name === 'SEC') upstreamStatusMap[clientId].sec = connected
    const card = document.querySelector(`.cp-card[data-client-id="${clientId}"]`)
    if (card) {
      const badge = card.querySelector(`.upstream-badge[data-upstream-name="${name}"]`)
      if (badge) {
        badge.className = `upstream-badge ${connected ? 'connected' : 'disconnected'}`
      } else {
        // Badge doesn't exist yet (card rendered before upstream status was known)
        const actionsEl = card.querySelector('.cp-actions')
        if (actionsEl) {
          const newBadge = document.createElement('span')
          newBadge.className = `upstream-badge ${connected ? 'connected' : 'disconnected'}`
          newBadge.dataset.upstreamName = name
          newBadge.dataset.upstreamConfigured = 'true'
          newBadge.textContent = name
          const onlineBadge = actionsEl.querySelector('.cp-online-badge')
          if (onlineBadge) onlineBadge.after(newBadge)
          else actionsEl.prepend(newBadge)
        }
      }
    }
  })

  es.addEventListener('meter-values-update', async (e) => {
    const { clientId } = JSON.parse(e.data)
    try {
      const meters = await api('GET', `/api/meters?clientId=${encodeURIComponent(clientId)}`)
      meterMap[clientId] = meters
      document.querySelectorAll(`.connector-badge[data-client-id="${clientId}"]`).forEach((badge) => {
        const evseId = +badge.dataset.evseId
        const connectorId = +badge.dataset.connectorId
        const connMeters = meters.filter((m) => m.evse_id === evseId && m.connector_id === connectorId)
        let metersDiv = badge.querySelector('.connector-meters')
        if (connMeters.length === 0) {
          if (metersDiv) metersDiv.remove()
          return
        }
        const html = connMeters
          .map(
            (m) =>
              `<span class="meter-val">${esc(m.measurand.split('.').pop())}: ${esc(Number(m.value).toFixed(1))} ${esc(m.unit ?? '')}</span>`
          )
          .join('')
        if (!metersDiv) {
          metersDiv = document.createElement('div')
          metersDiv.className = 'connector-meters'
          badge.appendChild(metersDiv)
        }
        metersDiv.innerHTML = html
      })
    } catch {}
  })

  es.addEventListener('transaction-open', () => {
    if (activeTab === 'status') loadStatus()
    if (activeTab === 'transactions') loadTransactions()
  })

  es.addEventListener('transaction-close', () => {
    if (activeTab === 'status') loadStatus()
    if (activeTab === 'transactions') loadTransactions()
  })

  es.addEventListener('ocpp-event', () => {
    if (activeTab === 'events' && activeSubtab === 'events') loadEvents()
  })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await initLocale()
  applyI18n()
  setupNav()

  try {
    await loadUpstreamStatus()
    await loadStatus()
  } catch (err) {
    console.error('loadStatus:', err)
  }

  setupEventsFilters()
  setupFaultsFilters()
  setupTxFilters()

  await Promise.allSettled([loadEvents(), loadFaults(), loadTransactions(), loadConfig()])

  initSSE()
}

init()
