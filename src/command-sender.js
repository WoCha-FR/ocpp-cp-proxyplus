class CommandSender {
  constructor() {
    this.pending = new Map()
  }

  send(ws, action, params, timeoutMs = 30000) {
    const messageId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId)
        reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))
      }, timeoutMs)
      this.pending.set(messageId, { resolve, reject, timer, ws })
      ws.send(JSON.stringify([2, messageId, action, params]))
    })
  }

  handleResponse(messageId, parsed) {
    const p = this.pending.get(messageId)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(messageId)
    p.resolve(parsed)
    return true
  }

  hasPending(messageId) {
    return this.pending.has(messageId)
  }

  clearForClient(ws) {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) {
        clearTimeout(p.timer)
        p.reject(Object.assign(new Error('client disconnected'), { code: 'DISCONNECTED' }))
        this.pending.delete(id)
      }
    }
  }
}

module.exports = CommandSender
