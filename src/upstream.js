/**
 * Upstream Connection Manager
 * Manages a WebSocket connection to one upstream server with automatic reconnection.
 *
 * Fix vs original: close() now nullifies onDisconnectedCallback before calling
 * ws.close(), preventing the 'close' event from triggering checkUpstreamsStatus
 * and accidentally closing the charger during a voluntary cleanup.
 */

const WebSocket = require('ws')
const { createLogger } = require('./logger')

class UpstreamConnection {
  constructor(name, baseUrl, clientId, protocol, clientIp, forwardedHeaders) {
    this.name = name
    this.baseUrl = baseUrl
    this.clientId = clientId
    this.protocol = protocol
    this.clientIp = clientIp || null
    this.forwardedHeaders = forwardedHeaders || {}
    this.log = createLogger(name, clientId)

    this.ws = null
    this.isConnected = false
    this.wasEverConnected = false
    this.closed = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.reconnectTimer = null

    this.onMessageCallback = null
    this.onConnectedCallback = null
    this.onDisconnectedCallback = null
    this.onGaveUpCallback = null
  }

  // ─── URL ────────────────────────────────────────────────────────────────────

  getUrl() {
    return `${this.baseUrl}${this.clientId}`
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect() {
    if (this.ws && this.isConnected) {
      this.log.debug('Already connected')
      return
    }

    const url = this.getUrl()
    this.log.debug(`Connecting to ${url}...`)

    try {
      const options = { headers: { ...this.forwardedHeaders } }

      if (this.clientIp) {
        options.headers['X-Forwarded-For'] = this.clientIp
        options.headers['X-Real-IP'] = this.clientIp
      }

      this.ws = new WebSocket(url, this.protocol, options)

      this.ws.on('open', () => {
        this.isConnected = true
        this.wasEverConnected = true
        this.reconnectAttempts = 0
        this.log.info(`Connected to ${url}`)
        this.onConnectedCallback?.(this.name)
      })

      this.ws.on('message', (data) => {
        this.onMessageCallback?.(data.toString(), this.name)
      })

      this.ws.on('error', (error) => {
        this.log.error(`WebSocket error: ${error.message}`)
      })

      this.ws.on('close', () => {
        this.isConnected = false
        this.log.warn('Disconnected')
        this.onDisconnectedCallback?.(this.name)

        if (!this.closed) {
          this.scheduleReconnect()
        }
      })
    } catch (error) {
      this.log.error(`Connection error: ${error.message}`)
      this.scheduleReconnect()
    }
  }

  // ─── Reconnection ────────────────────────────────────────────────────────────

  scheduleReconnect() {
    if (this.closed) return
    if (this.reconnectTimer) return

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error('Max reconnection attempts reached')
      this.onGaveUpCallback?.(this.name)
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000)
    this.log.info(
      `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.connect()
    }, delay)
  }

  // ─── Send ────────────────────────────────────────────────────────────────────

  send(data) {
    if (!this.isConnected || !this.ws) {
      this.log.warn('Cannot send — not connected')
      return false
    }
    try {
      this.ws.send(data)
      return true
    } catch (error) {
      this.log.error(`Send error: ${error.message}`)
      return false
    }
  }

  // ─── Close ───────────────────────────────────────────────────────────────────

  close() {
    this.closed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // FIX: nullify callback BEFORE ws.close() to prevent the 'close' event
    // from triggering checkUpstreamsStatus during a voluntary session cleanup.
    this.onDisconnectedCallback = null

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.isConnected = false
    this.log.info('Connection closed (no reconnect)')
  }

  // ─── Callbacks ───────────────────────────────────────────────────────────────

  onMessage(callback) {
    this.onMessageCallback = callback
  }
  onConnected(callback) {
    this.onConnectedCallback = callback
  }
  onDisconnected(callback) {
    this.onDisconnectedCallback = callback
  }
  onGaveUp(callback) {
    this.onGaveUpCallback = callback
  }
}

module.exports = UpstreamConnection
