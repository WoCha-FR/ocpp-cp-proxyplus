/**
 * OCPP Message Router
 * Handles routing logic and bidirectional ID remapping for OCPP messages.
 */

const { createLogger } = require('./logger')

// Separator used in proxy IDs.
// Must not appear in valid OCPP messageIds (UUIDs use hyphens, integers have none).
const ID_SEP = '~'

class OcppRouter {
  constructor(clientId, callTimeoutMs = 30000) {
    this.clientId = clientId
    this.callTimeoutMs = callTimeoutMs
    this.log = createLogger('Router', clientId)

    // Maps proxyId ("PRI~abc") → { serverName: "PRI", originalId: "abc", timer }
    // Populated when an upstream sends a CALL to the client.
    // Consumed (and deleted) when the client sends the matching CALLRESULT/CALLERROR.
    this.serverCallMap = new Map()

    // Tracks messageIds of CALLs originated by the client.
    // Used to ensure only the primary server's CALLRESULT/CALLERROR is relayed back.
    // Entries are never deleted (cleared only on session teardown via clear()).
    this.clientCallIds = new Set()
  }

  // ─── Parsing ────────────────────────────────────────────────────────────────

  /**
   * Parse a raw OCPP frame.
   * @param {string} data
   * @returns {{ raw: string, type: number, messageId: string, parsed: Array }|null}
   */
  parseMessage(data) {
    try {
      const parsed = JSON.parse(data)
      if (!Array.isArray(parsed) || parsed.length < 2) return null
      return { raw: data, type: parsed[0], messageId: parsed[1], parsed }
    } catch (err) {
      this.log.error(`Failed to parse OCPP message: ${err.message}`)
      return null
    }
  }

  // ─── Client → Upstream ──────────────────────────────────────────────────────

  /**
   * Register a CALL emitted by the client.
   * Ensures only the primary server's response is relayed back.
   * @param {string} messageId
   */
  registerClientCall(messageId) {
    this.clientCallIds.add(messageId)
    this.log.debug(`Registered client CALL: ${messageId}`)
  }

  /**
   * Determine whether a CALLRESULT/CALLERROR from an upstream should be
   * forwarded to the client.
   *
   * Rules:
   * - If the messageId is NOT a client-originated CALL → always relay
   *   (it's the response to a server-initiated CALL, routed by remapServerCall)
   * - If it IS a client CALL → only relay from primaryServerName
   *
   * @param {string} messageId  - original client messageId (not prefixed)
   * @param {string} serverName
   * @param {string} primaryServerName
   * @returns {boolean}
   */
  shouldRelayResponseToClient(messageId, serverName, primaryServerName) {
    if (!this.clientCallIds.has(messageId)) return true

    if (serverName === primaryServerName) {
      this.log.info(`Relaying response from ${serverName} for ${messageId}`)
      return true
    }

    this.log.debug(`Dropping response from ${serverName} for ${messageId} (not primary)`)
    return false
  }

  /**
   * Determine routing for a message coming FROM the client.
   *
   * Returns:
   *   { sendToAll: true }                              — type 2 (CALL)
   *   { sendToServer: name, remappedData: string }     — type 3/4 with deprefixed id
   *   { sendToAll: false, sendToServer: null }         — unknown / no mapping
   *
   * @param {object} message - parsed message
   * @returns {object}
   */
  routeClientMessage(message) {
    if (!message) return { sendToAll: false, sendToServer: null }

    switch (message.type) {
      case 2: // CALL → broadcast to all upstreams
        if (message.parsed.length < 4) {
          this.log.warn(`Malformed CALL (${message.parsed.length} elements) — dropping`)
          return { sendToAll: false, sendToServer: null, remappedData: null }
        }
        this.log.info(`CALL from client (${message.messageId}) → ALL`)
        return { sendToAll: true, sendToServer: null, remappedData: null }

      case 3: // CALLRESULT
      case 4: {
        // CALLERROR
        if (message.type === 4 && message.parsed.length < 5) {
          this.log.warn(`Malformed CALLERROR (${message.parsed.length} elements) — dropping`)
          return { sendToAll: false, sendToServer: null, remappedData: null }
        }
        const label = message.type === 3 ? 'CALLRESULT' : 'CALLERROR'
        const proxyId = message.messageId
        const entry = this.serverCallMap.get(proxyId)

        if (!entry) {
          this.log.warn(`No server mapping for ${proxyId} — dropping`)
          return { sendToAll: false, sendToServer: null, remappedData: null }
        }

        clearTimeout(entry.timer)
        this.serverCallMap.delete(proxyId)
        this.log.info(`${label} from client (${proxyId}) → ${entry.serverName} (originalId: ${entry.originalId})`)

        // Restore the upstream's original id before forwarding
        const restored = [...message.parsed]
        restored[1] = entry.originalId
        return { sendToAll: false, sendToServer: entry.serverName, remappedData: JSON.stringify(restored) }
      }

      default:
        this.log.warn(`Unknown message type ${message.type}`)
        return { sendToAll: false, sendToServer: null, remappedData: null }
    }
  }

  // ─── Upstream → Client ──────────────────────────────────────────────────────

  /**
   * Remap a CALL coming from an upstream before forwarding it to the client.
   * Prefixes the messageId with the server name to guarantee uniqueness.
   *
   * Example: PRI sends [2, "abc", "RemoteStart", {}]
   *          → stored: serverCallMap["PRI~abc"] = { serverName: "PRI", originalId: "abc" }
   *          → returns: '[2,"PRI~abc","RemoteStart",{}]'
   *
   * @param {object} message   - parsed upstream CALL (type 2)
   * @param {string} serverName - "PRI" or "SEC"
   * @returns {string} remapped raw frame to send to the client
   */
  remapServerCall(message, serverName) {
    const originalId = message.messageId
    const proxyId = `${serverName}${ID_SEP}${originalId}`

    const timer = setTimeout(() => {
      if (this.serverCallMap.has(proxyId)) {
        this.serverCallMap.delete(proxyId)
        this.log.warn(`Timeout: client did not respond to server CALL ${proxyId} — mapping discarded`)
      }
    }, this.callTimeoutMs)

    this.serverCallMap.set(proxyId, { serverName, originalId, timer })
    this.log.debug(`Remapped CALL ${serverName}:${originalId} → ${proxyId}`)

    const remapped = [...message.parsed]
    remapped[1] = proxyId
    return JSON.stringify(remapped)
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Clear all state. Called on session teardown.
   */
  clear() {
    this.serverCallMap.forEach((entry) => clearTimeout(entry.timer))
    this.serverCallMap.clear()
    this.clientCallIds.clear()
    this.log.debug('Cleared all message mappings')
  }
}

module.exports = OcppRouter
