/**
 * Initialisation de la base de données SQLite et exécution des migrations.
 * Centralisation de la logique d'accès à la base de données pour l'ensemble de l'application.
 */
const Database = require('better-sqlite3')
const path = require('path')
const { getConfigDir } = require('./config')
const { runMigrations } = require('./migrator')

const DB_PATH = path.resolve(getConfigDir(), 'cpproxy.db')
let db

function getDb() {
  if (!db) {
    const fs = require('fs')
    const dir = path.dirname(DB_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  }
  return db
}

function closeDb() {
  if (!db) return
  db.close()
  db = undefined
}

module.exports = { getDb, closeDb }
