/**
 * WebSocket OCPP Proxy — Entry Point
 */

const OcppProxy = require('./proxy')
const Notify = require('./notify')
const configModule = require('./config')
const dbModule = require('./database')
const { createLogger, setLogLevel } = require('./logger')

const log = createLogger('Main')
const config = configModule.getConfig()
const db = dbModule.getDb()

// ─── Config loading ───────────────────────────────────────────────────────────

if (config.logLevel) setLogLevel(config.logLevel)
log.info(`Configuration loaded from ${configModule.getConfigFilePath()}`)

// ─── Validation ───────────────────────────────────────────────────────────────

if (!config.proxy?.host || !config.proxy?.port) {
  log.error('Invalid config: proxy.host and proxy.port are required')
  process.exit(1)
}

// ─── Start proxy ──────────────────────────────────────────────────────────────

const notifier = new Notify(config.notify, db)
const proxy = new OcppProxy(config, notifier)

log.debug('========================================')
log.debug('WebSocket OCPP Proxy')
log.debug('========================================')
log.debug(`Proxy  : ${config.proxy.host}:${config.proxy.port}`)
log.debug(`Routing: ${JSON.stringify(config.routing)}`)

try {
  proxy.start()
} catch (err) {
  log.error(`Failed to start proxy: ${err.message}`)
  process.exit(1)
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = () => {
  log.info('Shutting down...')
  proxy.stop()
  db.closeDb()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  log.error(`Unhandled rejection at: ${promise}, reason: ${reason}`)
  process.exit(1)
})
