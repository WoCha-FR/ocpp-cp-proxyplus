/**
 * WebSocket OCPP Proxy
 * Main proxy logic: client connections, upstream management, message routing.
 */

const WebSocket = require('ws')
const OcppRouter = require('./ocpp-router')
const UpstreamConnection = require('./upstream')
const { createLogger } = require('./logger')
const CommandSender = require('./command-sender')
const eventBus = require('./event-bus')

const log = createLogger('Proxy')

function resolveUpstreams(config, clientId) {
  if (config.routing) {
    const entry = config.routing[clientId] ?? config.routing.default
    if (entry) {
      const urls = entry
      return urls.map((url, i) => ({ name: i === 0 ? 'PRI' : 'SEC', url }))
    }
  }
  // Rétrocompatibilité : primaryUrl / secondaryUrl globaux
  const result = [{ name: 'PRI', url: config.primaryUrl }]
  if (config.secondaryUrl) result.push({ name: 'SEC', url: config.secondaryUrl })
  return result
}

class OcppProxy {
  constructor(config, notifier = null) {
    this.config = config
    this.server = null
    this.notifier = notifier
    this.heartbeatInterval = null
    this.clientConnections = new Map() // clientWs → connectionInfo
    this.commandSender = new CommandSender()
  }

  // ─── Start / Stop ─────────────────────────────────────────────────────────

  start() {
    const { host, port } = this.config.proxy

    this.server = new WebSocket.Server({
      host,
      port,
      // eslint-disable-next-line no-unused-vars
      handleProtocols: (protocols, request) => {
        const arr = Array.isArray(protocols) ? protocols : Array.from(protocols)
        if (arr.includes('ocpp2.0.1')) return 'ocpp2.0.1'
        if (arr.includes('ocpp1.6')) return 'ocpp1.6'
        if (arr.length === 0) return 'ocpp1.6'
        return false
      },
    })

    this.server.on('connection', (ws, request) => this.handleClientConnection(ws, request))
    this.server.on('error', (error) => log.error(`Server error: ${error.message}`))

    const heartbeatIntervalMs = this.config.heartbeatIntervalMs ?? 30000
    this.heartbeatInterval = setInterval(() => {
      this.server.clients.forEach((ws) => {
        try {
          if (ws.isAlive === false) {
            ws.terminate()
            return
          }
          ws.isAlive = false
          ws.ping()
        } catch (err) {
          log.error(`Heartbeat error: ${err.message}`)
        }
      })
    }, heartbeatIntervalMs)
    this.server.on('close', () => {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    })

    log.info(`WebSocket proxy listening on ${host}:${port}`)
  }

  stop() {
    if (!this.server) return
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.clientConnections.forEach((_, ws) => this.cleanupClientConnection(ws))
    this.server.close(() => log.info('Server stopped'))
  }

  // ─── Client connection ────────────────────────────────────────────────────

  handleClientConnection(clientWs, request) {
    const rawPath = request.url || '/'
    const match = rawPath.replace(/^\/+/, '').match(/^([a-zA-Z0-9_-]+)$/)

    if (!match) {
      log.warn(`Rejected: invalid path "${rawPath}"`)
      clientWs.close(1008, 'Invalid path')
      return
    }

    const clientId = match[1]
    const protocol = clientWs.protocol || 'ocpp1.6'
    const clog = createLogger('Proxy', clientId)

    // Replace existing session with same clientId
    for (const [existingWs, info] of this.clientConnections) {
      if (info.clientId === clientId) {
        clog.warn('Replacing existing connection for this clientId')
        this.cleanupClientConnection(existingWs)
        existingWs.close(1001, 'Replaced by new connection')
        break
      }
    }

    clog.info(`New connection — protocol: ${protocol}`)
    clientWs.isAlive = true
    clientWs.on('pong', () => {
      clientWs.isAlive = true
    })
    this.notifier?.connectedToProxy(clientId)

    const clientIp = (request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress

    const forwardedHeaders = {}
    if (request.headers['authorization']) forwardedHeaders['Authorization'] = request.headers['authorization']
    if (request.headers['user-agent']) forwardedHeaders['User-Agent'] = request.headers['user-agent']

    const router = new OcppRouter(clientId, this.config.callTimeoutMs ?? 30000)

    const upstreams = resolveUpstreams(this.config, clientId).map(
      ({ name, url }) => new UpstreamConnection(name, url, clientId, protocol, clientIp, forwardedHeaders)
    )

    if (!upstreams.length) {
      clog.error('No upstream configured — rejecting connection')
      clientWs.close(1011, 'No upstream configured')
      return
    }

    const connectionInfo = { clientId, clientWs, upstreams, router, protocol, messageBuffer: [] }
    this.clientConnections.set(clientWs, connectionInfo)

    // Wire upstream events
    upstreams.forEach((upstream) => {
      upstream.onMessage((data, serverName) => {
        this.handleUpstreamMessage(clientWs, data, serverName, router)
      })

      upstream.onConnected((serverName) => {
        this.sendBufferToUpstream(clientWs, upstream)
        this.flushMessageBufferIfAllConnected(clientWs)
        this.notifier?.connectedToUpstream(clientId, serverName)
        eventBus.emit('upstream-update', { clientId, name: serverName, connected: true })
      })

      upstream.onDisconnected((serverName) => {
        this.checkUpstreamsStatus(clientWs)
        if (upstream.wasEverConnected) {
          this.notifier?.disconnectedFromUpstream(clientId, serverName)
        }
        eventBus.emit('upstream-update', { clientId, name: serverName, connected: false })
      })

      upstream.onGaveUp(() => {
        this.flushMessageBufferIfAllConnected(clientWs)
        this.checkUpstreamsStatus(clientWs)
      })

      upstream.connect()
    })

    // Wire client events
    clientWs.on('message', (data) => {
      const msg = data.toString()
      const info = this.clientConnections.get(clientWs)

      // Always handle responses to proxy-initiated commands (UI commands), regardless of upstream state
      if (info) {
        const message = router.parseMessage(msg)
        if (message && (message.type === 3 || message.type === 4) && this.commandSender.hasPending(message.messageId)) {
          this.commandSender.handleResponse(message.messageId, message.parsed)
          return
        }
      }

      if (info && !upstreams[0].isConnected) {
        const maxBuffer = this.config.maxBufferSize ?? 100
        if (info.messageBuffer.length >= maxBuffer) {
          clog.warn(`Message buffer full (${maxBuffer}) — closing client`)
          clientWs.close(1008, 'Message buffer overflow')
          return
        }
        clog.info(`Buffering message (${info.messageBuffer.length + 1} in buffer)`)
        info.messageBuffer.push(msg)
        return
      }

      this.handleClientMessage(clientWs, msg, upstreams, router)
    })

    clientWs.on('close', () => {
      clog.info('Client disconnected')
      this.notifier?.disconnectedFromProxy(clientId)
      this.notifier?.clearPending(clientId)
      this.cleanupClientConnection(clientWs)
    })

    clientWs.on('error', (error) => clog.error(`Client error: ${error.message}`))
  }

  // ─── Message routing ──────────────────────────────────────────────────────

  /**
   * Message from client → route to upstreams.
   *
   * type 2 (CALL)         → broadcast to all connected upstreams
   * type 3/4 (reply)      → send deprefixed frame to the matching upstream
   */
  handleClientMessage(clientWs, data, upstreams, router) {
    const info = this.clientConnections.get(clientWs)
    const clog = createLogger('Proxy', info?.clientId ?? '?')
    const message = router.parseMessage(data)

    if (!message) {
      clog.warn('Invalid message from client — ignoring')
      return
    }

    if ((message.type === 3 || message.type === 4) && this.commandSender.hasPending(message.messageId)) {
      this.commandSender.handleResponse(message.messageId, message.parsed)
      return
    }

    const routing = router.routeClientMessage(message)

    if (routing.sendToAll) {
      if (message.type === 2) {
        router.registerClientCall(message.messageId)
        this.notifier?.callFromClient(info?.clientId, data)
      }

      upstreams.forEach((upstream) => {
        if (upstream.isConnected) {
          upstream.send(data)
        } else {
          clog.warn(`Cannot send to ${upstream.name} — not connected`)
        }
      })
    } else if (routing.sendToServer) {
      // For CALLRESULT/CALLERROR: send the deprefixed frame, not the raw one
      const frameToSend = routing.remappedData ?? data
      const target = upstreams.find((u) => u.name === routing.sendToServer)

      if (target?.isConnected) {
        target.send(frameToSend)
      } else {
        clog.warn(`Target ${routing.sendToServer} not found or not connected`)
      }
    }
  }

  /**
   * Message from upstream → forward to client.
   *
   * type 2 (CALL)         → remap ID (PRI~abc / SEC~abc) then send
   * type 3/4 (response)   → relay only if from primary (for client-originated CALLs)
   */
  handleUpstreamMessage(clientWs, data, serverName, router) {
    const info = this.clientConnections.get(clientWs)
    const message = router.parseMessage(data)

    if (!message) return

    let frameToClient = data

    if (message.type === 2) {
      if (message.parsed.length < 4) {
        createLogger('Proxy', info?.clientId ?? '?').warn(
          `Malformed CALL from ${serverName} (${message.parsed.length} elements) — dropping`
        )
        return
      }
      // CALL from upstream: remap ID to avoid PRI/SEC collision on the client side
      frameToClient = router.remapServerCall(message, serverName)
      this.notifier?.callFromUpstream(info?.clientId, message)
    } else if (message.type === 3 || message.type === 4) {
      // Response to a client-originated CALL: only relay from primary
      const primaryName = info?.upstreams[0]?.name ?? null

      if (!router.shouldRelayResponseToClient(message.messageId, serverName, primaryName)) {
        return
      }
      // frameToClient stays as-is (id is the original client id)
      this.notifier?.callResultFromUpstream(info?.clientId, message.messageId, message.parsed)
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(frameToClient)
      } catch (error) {
        createLogger('Proxy', info?.clientId ?? '?').error(`Send error: ${error.message}`)
      }
    }
  }

  // ─── Buffer management ────────────────────────────────────────────────────

  /**
   * When an upstream connects, replay the buffer to it.
   * - Primary:   route through handleClientMessage (registers CALLs in router)
   * - Secondary: send raw (PRI already registered the CALLs)
   */
  sendBufferToUpstream(clientWs, upstream) {
    const info = this.clientConnections.get(clientWs)
    if (!info || info.messageBuffer.length === 0) return

    const { upstreams, router, clientId } = info
    const clog = createLogger('Proxy', clientId)
    const isPrimary = upstream === upstreams[0]

    if (isPrimary) {
      clog.info(`PRI connected — routing ${info.messageBuffer.length} buffered message(s) through router`)
      const messages = [...info.messageBuffer]
      for (const msg of messages) {
        // Only send to primary here; secondary will receive its copy via its own sendBufferToUpstream call.
        this.handleClientMessage(clientWs, msg, [upstream], router)
      }
    } else {
      clog.info(`Sending ${info.messageBuffer.length} buffered message(s) to ${upstream.name}`)
      const messages = [...info.messageBuffer]
      for (const msg of messages) {
        upstream.send(msg)
      }
    }
  }

  /**
   * Clear the buffer once all upstreams are resolved (connected or gave up).
   */
  flushMessageBufferIfAllConnected(clientWs) {
    const info = this.clientConnections.get(clientWs)
    if (!info || info.messageBuffer.length === 0) return

    const allResolved = info.upstreams.every((u) => u.isConnected || u.reconnectAttempts >= u.maxReconnectAttempts)

    if (allResolved) {
      createLogger('Proxy', info.clientId).info(
        `All upstreams resolved — clearing buffer (${info.messageBuffer.length} messages)`
      )
      info.messageBuffer = []
    }
  }

  // ─── Upstream health ──────────────────────────────────────────────────────

  checkUpstreamsStatus(clientWs) {
    const info = this.clientConnections.get(clientWs)
    if (!info) return

    const clog = createLogger('Proxy', info.clientId)

    const someStillConnecting = info.upstreams.some(
      (u) => !u.isConnected && !u.wasEverConnected && u.reconnectAttempts < u.maxReconnectAttempts
    )
    if (someStillConnecting) {
      clog.info('Some upstreams still connecting — keeping client alive')
      return
    }

    if (info.upstreams.every((u) => !u.isConnected)) {
      clog.info('All upstreams disconnected — closing client')
      clientWs.close(1001, 'All upstream servers unavailable')
      this.cleanupClientConnection(clientWs)
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  getUpstreamStatus() {
    const result = {}
    for (const info of this.clientConnections.values()) {
      const pri = info.upstreams[0]
      const sec = info.upstreams[1] ?? null
      result[info.clientId] = {
        pri: pri?.isConnected ?? false,
        sec: sec ? sec.isConnected : null,
      }
    }
    return result
  }

  getClientConnection(clientId) {
    for (const [ws, info] of this.clientConnections) {
      if (info.clientId === clientId) return { ws, protocol: info.protocol }
    }
    return null
  }

  getConnectedClientIds() {
    return [...this.clientConnections.values()].map((info) => info.clientId)
  }

  reloadRouting() {
    log.info('Routing config changed — dropping all client connections for reconnect')
    this.clientConnections.forEach((_, ws) => {
      this.cleanupClientConnection(ws)
      if (ws.readyState === ws.OPEN) ws.close(1001, 'Routing config reloaded')
    })
  }

  cleanupClientConnection(clientWs) {
    const info = this.clientConnections.get(clientWs)
    if (!info) return

    this.commandSender.clearForClient(clientWs)
    info.upstreams.forEach((u) => u.close())
    info.router.clear()
    this.clientConnections.delete(clientWs)

    createLogger('Proxy', info.clientId).info('Connection cleanup complete')
  }
}

module.exports = OcppProxy
