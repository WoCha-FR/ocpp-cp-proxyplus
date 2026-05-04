/**
 * Initialisation de la configuration.
 * Les fichiers de configuration sont dans le dossier config.
 */
const fs = require('fs')
const path = require('path')
const { logger } = require('./logger')

const CONFIG_DIR = path.join(__dirname, '..', 'config')
const SAMPLE_FILE = path.join(CONFIG_DIR, 'config.sample.json')

let config = null

// Overrides de configuration via variables d'environnement.
// Seules les valeurs liées au déploiement (URLs, secrets) sont concernées.
// type: 'auto' (défaut) = cast automatique booléen/nombre, 'string' = toujours string.
const ENV_OVERRIDES = [
  // Routing (mirroring dual-CSMS : primary = réponses relayées au CP)
  { env: 'OCPP_UPSTREAM_PRIMARY', path: ['routing', 'default', 0], type: 'string' },
  { env: 'OCPP_UPSTREAM_SECONDARY', path: ['routing', 'default', 1], type: 'string' },
  // Proxy / Dashboard
  { env: 'PROXY_PORT', path: ['proxy', 'port'], type: 'auto' },
  { env: 'DASHBOARD_PORT', path: ['dashboard', 'port'], type: 'auto' },
  { env: 'DASHBOARD_USERNAME', path: ['dashboard', 'username'], type: 'string' },
  { env: 'DASHBOARD_PASSWORD', path: ['dashboard', 'password'], type: 'string' },
  // Logs
  { env: 'LOG_LEVEL', path: ['logLevel'], type: 'string' },
  // Email — host/port/tls restent dans config.json (objet transport passé en entier à nodemailer)
  { env: 'NOTIFY_EMAIL_ENABLED', path: ['notify', 'email', 'enabled'], type: 'auto' },
  { env: 'SMTP_USER', path: ['notify', 'email', 'transport', 'auth', 'user'], type: 'string' },
  { env: 'SMTP_PASS', path: ['notify', 'email', 'transport', 'auth', 'pass'], type: 'string' },
  { env: 'SMTP_FROM', path: ['notify', 'email', 'from'], type: 'string' },
  { env: 'SMTP_TO', path: ['notify', 'email', 'to'], type: 'string' },
  // Pushover
  { env: 'NOTIFY_PUSHOVER_ENABLED', path: ['notify', 'pushover', 'enabled'], type: 'auto' },
  { env: 'NOTIFY_PUSHOVER_TOKEN', path: ['notify', 'pushover', 'token'], type: 'string' },
  { env: 'NOTIFY_PUSHOVER_USER', path: ['notify', 'pushover', 'user'], type: 'string' },
]

function resolveConfigPath() {
  // Priorité 1 : config.dev.json si NODE_ENV=development
  if (process.env.NODE_ENV === 'development') {
    const devFile = path.join(CONFIG_DIR, 'config.dev.json')
    if (fs.existsSync(devFile)) {
      return { file: devFile }
    }
    logger.warn('config/config.dev.json not found, fallback on config/config.json')
  }
  // Priorité 2 : config/config.json (défaut)
  return { file: path.join(CONFIG_DIR, 'config.json') }
}

function loadConfig() {
  if (config) return config
  const { file } = resolveConfigPath()
  if (!fs.existsSync(file)) {
    if (fs.existsSync(SAMPLE_FILE)) {
      logger.error(`Configuration file not found: ${file}`)
      logger.error(`Copy config/config.sample.json to config/config.json and edit it:`)
      logger.error(`  cp config/config.sample.json config/config.json`)
    } else {
      logger.error(`Configuration file not found: ${file}`)
    }
    process.exit(1)
  }
  const raw = fs.readFileSync(file, 'utf-8')
  config = JSON.parse(raw)
  applyEnvOverrides(config)
  validateConfig(config)
  logger.info(`Configuration loaded from: ${file}`)
  return config
}

function castEnvValue(raw, type) {
  if (type === 'string') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  const num = Number(raw)
  if (!Number.isNaN(num) && raw.trim() !== '') return num
  return raw
}

function applyEnvOverrides(cfg) {
  for (const { env, path: keys, type } of ENV_OVERRIDES) {
    const raw = process.env[env]
    if (raw === undefined) continue
    const value = castEnvValue(raw, type)
    let obj = cfg
    for (let i = 0; i < keys.length - 1; i++) {
      if (obj[keys[i]] == null || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {}
      obj = obj[keys[i]]
    }
    obj[keys[keys.length - 1]] = value
    logger.debug(`Config override from env: ${env}`)
  }
}

function validateConfig(cfg) {
  const required = ['routing.default']
  const missing = required.filter((key) => {
    const parts = key.split('.')
    let obj = cfg
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object' || !(p in obj)) return true
      obj = obj[p]
    }
    return obj === undefined
  })
  if (missing.length > 0) {
    logger.error(`Missing required config keys: ${missing.join(', ')}`)
    logger.error('Check config/config.sample.json for the expected structure.')
    process.exit(1)
  }

  if (cfg.routing) {
    for (const [key, value] of Object.entries(cfg.routing)) {
      if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
        logger.error(`routing.${key} must be an array with 1 or 2 URLs`)
        logger.error('Check config/config.sample.json for the expected structure.')
        process.exit(1)
      }
    }
  }
}

function getConfig() {
  if (!config) loadConfig()
  return config
}

/**
 * Retourne le dossier où le fichier de config a été chargé.
 * Permet de résoudre les chemins relatifs (DB, certificats) depuis ce dossier.
 */
function getConfigDir() {
  return CONFIG_DIR
}

function getConfigFilePath() {
  const { file } = resolveConfigPath()
  return file
}

module.exports = { getConfig, getConfigDir, getConfigFilePath }
