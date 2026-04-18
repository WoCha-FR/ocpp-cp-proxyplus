/**
 * Winston Logger Configuration
 * Provides a centralized logger with clientId support
 */

const winston = require('winston')

const { combine, timestamp, printf, colorize } = winston.format

// Custom format that includes clientId when available
const logFormat = printf(({ level, message, timestamp, clientId, component }) => {
  const comp = component ? `[${component}]` : ''
  const client = clientId ? ` [${clientId}]` : ''
  return `${timestamp} ${level} ${comp}${client} ${message}`
})

const logger = winston.createLogger({
  level: 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss:SSS' }), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss:SSS' }), logFormat),
    }),
  ],
})

/**
 * Set the log level
 * @param {string} level - Winston log level (error, warn, info, verbose, debug, silly)
 */
function setLogLevel(level) {
  logger.level = level
}

/**
 * Create a child logger with a fixed clientId and component
 * @param {string} component - Component name (e.g. 'Proxy', 'Router', 'Upstream')
 * @param {string} [clientId] - Client identifier
 * @returns {object} Child logger
 */
function createLogger(component, clientId) {
  return logger.child({ component, clientId })
}

module.exports = { logger, createLogger, setLogLevel }
