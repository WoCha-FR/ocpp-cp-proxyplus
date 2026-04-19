const express = require('express')
const basicAuth = require('express-basic-auth')
const path = require('path')
const fs = require('fs')
const Store = require('./store')
const { writeConfig } = require('./config-writer')
const { createLogger } = require('./logger')
const eventBus = require('./event-bus')

const log = createLogger('HttpServer')
const LOCALES_DIR = path.join(__dirname, '..', 'locales')
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

function createHttpServer(config, db, proxy, notifier) {
  const app = express()
  const store = new Store(db)

  app.use(express.json())

  if (config.dashboard?.username) {
    app.use(basicAuth({ users: { [config.dashboard.username]: config.dashboard.password ?? '' }, challenge: true }))
  }

  app.use('/locales', express.static(LOCALES_DIR))
  app.use(express.static(PUBLIC_DIR))

  // ─── Chargepoints & Status ────────────────────────────────────────────────

  app.get('/api/status', (_req, res) => res.json(store.getStatus()))

  app.get('/api/connected', (_req, res) => res.json(proxy?.getConnectedClientIds() ?? []))

  app.get('/api/meters', (req, res) => res.json(store.getCurrentMeterValues(req.query.clientId || null)))

  app.get('/api/chargepoints', (_req, res) => res.json(store.getChargepoints()))

  app.put('/api/chargepoints/:clientId/name', (req, res) => {
    store.updateChargepointName(req.params.clientId, req.body.name ?? null)
    res.json({ ok: true })
  })

  // ─── Events / Faults / Transactions ──────────────────────────────────────

  app.get('/api/events', (req, res) => {
    const { page, limit, type, clientId } = req.query
    res.json(
      store.getEvents({ page: page ? +page : 1, limit: limit ? +limit : 50, type: type || null, clientId: clientId || null })
    )
  })

  app.get('/api/faults', (req, res) => {
    const { page, limit, clientId, cleared } = req.query
    res.json(
      store.getFaultEvents({
        page: page ? +page : 1,
        limit: limit ? +limit : 50,
        clientId: clientId || null,
        cleared: cleared !== undefined ? +cleared : null,
      })
    )
  })

  app.get('/api/transactions', (req, res) => {
    const { page, limit, clientId } = req.query
    res.json(store.getTransactions({ page: page ? +page : 1, limit: limit ? +limit : 50, clientId: clientId || null }))
  })

  // ─── Config ───────────────────────────────────────────────────────────────

  app.get('/api/config', (_req, res) => res.json(config))

  app.put('/api/config/notify', (req, res) => {
    Object.assign(config.notify, req.body)
    writeConfig(config)
    notifier?.reload()
    res.json({ ok: true })
  })

  app.put('/api/config/email', (req, res) => {
    config.notify.email = { ...config.notify.email, ...req.body }
    writeConfig(config)
    notifier?.reload()
    res.json({ ok: true })
  })

  app.put('/api/config/pushover', (req, res) => {
    config.notify.pushover = { ...config.notify.pushover, ...req.body }
    writeConfig(config)
    notifier?.reload()
    res.json({ ok: true })
  })

  app.put('/api/config/routing', (req, res) => {
    config.routing = req.body
    writeConfig(config)
    proxy.reloadRouting()
    res.json({ ok: true })
  })

  // ─── Locale metadata ──────────────────────────────────────────────────────

  app.get('/api/locale', (_req, res) => {
    const supported = fs
      .readdirSync(LOCALES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
    res.json({ lang: config.lang ?? 'fr', supported })
  })

  // ─── Commands ─────────────────────────────────────────────────────────────

  app.post('/api/commands/:clientId/:action', async (req, res) => {
    const { clientId, action } = req.params
    const conn = proxy?.getClientConnection(clientId)
    if (!conn) return res.status(404).json({ error: 'not_connected' })

    const { ws, protocol } = conn
    const body = req.body ?? {}
    let ocppAction, ocppParams

    switch (action) {
      case 'reset':
        ocppAction = 'Reset'
        ocppParams =
          protocol === 'ocpp2.0.1' ? { type: body.type === 'Hard' ? 'Immediate' : 'OnIdle' } : { type: body.type ?? 'Soft' }
        break
      case 'unlock':
        ocppAction = 'UnlockConnector'
        ocppParams =
          protocol === 'ocpp2.0.1'
            ? { evseId: body.evseId ?? 1, connectorId: body.connectorId ?? 1 }
            : { connectorId: body.connectorId ?? 1 }
        break
      case 'trigger':
        ocppAction = 'TriggerMessage'
        ocppParams = { requestedMessage: body.message ?? 'BootNotification' }
        break
      case 'diagnostics':
        if (protocol === 'ocpp2.0.1') {
          ocppAction = 'GetLog'
          ocppParams = { logType: 'DiagnosticsLog', requestId: Date.now(), log: { remoteLocation: body.location ?? '' } }
        } else {
          ocppAction = 'GetDiagnostics'
          ocppParams = { location: body.location ?? '' }
        }
        break
      case 'get-config':
        if (protocol === 'ocpp2.0.1') {
          const keys = body.keys ?? []
          ocppAction = 'GetVariables'
          ocppParams = {
            getVariableData: keys.map((k) => ({ component: { name: 'ChargingStation' }, variable: { name: k } })),
          }
        } else {
          ocppAction = 'GetConfiguration'
          ocppParams = body.keys?.length ? { key: body.keys } : {}
        }
        break
      default:
        return res.status(400).json({ error: 'unknown_action' })
    }

    try {
      const result = await proxy.commandSender.send(ws, ocppAction, ocppParams)
      const payload = result[2] ?? {}
      res.json({ status: payload.status ?? 'Accepted', result: payload })
    } catch (err) {
      if (err.code === 'TIMEOUT') return res.status(408).json({ error: 'timeout' })
      return res.status(500).json({ error: err.message })
    }
  })

  // ─── SSE ─────────────────────────────────────────────────────────────────

  app.get('/api/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    const handlers = {
      'ocpp-event': (d) => send('ocpp-event', d),
      'meter-values-update': (d) => send('meter-values-update', d),
      'status-update': (d) => send('status-update', d),
      'transaction-open': (d) => send('transaction-open', d),
      'transaction-close': (d) => send('transaction-close', d),
      'fault-event': (d) => send('fault-event', d),
      'fault-cleared': (d) => send('fault-cleared', d),
      'client-connected': (d) => send('client-connected', d),
      'client-disconnected': (d) => send('client-disconnected', d),
    }

    for (const [event, handler] of Object.entries(handlers)) eventBus.on(event, handler)
    const heartbeat = setInterval(() => send('heartbeat', { ts: Date.now() }), 30000)

    req.on('close', () => {
      clearInterval(heartbeat)
      for (const [event, handler] of Object.entries(handlers)) eventBus.off(event, handler)
    })
  })

  // ─── HEALTHCHECK ─────────────────────────────────────────────────────────

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  const port = config.dashboard?.port ?? 3000
  app.listen(port, () => log.info(`Dashboard listening on port ${port}`))

  return app
}

module.exports = { createHttpServer }
