-- Inventaire des bornes (BootNotification)
CREATE TABLE IF NOT EXISTS chargepoints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT UNIQUE NOT NULL,
  name         TEXT,              -- Nom humain optionnel, affiché à la place de client_id
  vendor       TEXT,
  model        TEXT,
  serial       TEXT,
  firmware     TEXT,
  last_seen    INTEGER NOT NULL,
  first_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,   -- 'connected_proxy' | 'disconnected_proxy'
                                 -- 'connected_upstream' | 'disconnected_upstream'
                                 -- 'status_notification' | 'start_transaction' | 'stop_transaction'
                                 -- 'transaction_event' (OCPP 2.0.1)
                                 -- 'authorize' | 'boot_notification'
  client_id    TEXT NOT NULL,
  evse_id      INTEGER,          -- NULL si non applicable, 0 = CP level, ≥1 = EVSE réel
  connector_id INTEGER,
  payload      TEXT             -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);

CREATE TABLE IF NOT EXISTS connector_status (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL,
  evse_id      INTEGER NOT NULL DEFAULT 0,  -- 0 = OCPP 1.6 / CP level
  connector_id INTEGER NOT NULL,
  status       TEXT NOT NULL,
  status_raw TEXT, -- statut brut 2.0.1 avant normalisation
  error_code   TEXT,
  updated_at   INTEGER NOT NULL,
  UNIQUE(client_id, evse_id, connector_id)
);

CREATE TABLE IF NOT EXISTS status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  client_id    TEXT NOT NULL,
  evse_id      INTEGER NOT NULL DEFAULT 0,
  connector_id INTEGER NOT NULL,
  status       TEXT NOT NULL,
  status_raw TEXT, -- statut brut 2.0.1 avant normalisation
  error_code   TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL,
  evse_id      INTEGER NOT NULL DEFAULT 0,
  connector_id INTEGER NOT NULL,
  ocpp_tx_id   TEXT,             -- INTEGER en 1.6, string/UUID en 2.0.1
  id_tag       TEXT,
  meter_start  INTEGER,
  meter_stop   INTEGER,
  started_at   INTEGER NOT NULL,
  start_source TEXT DEFAULT 'rfid' CHECK(start_source IN ('rfid', 'local', 'remote')),
  stopped_at   INTEGER,
  stop_reason  TEXT,
  energy_wh    INTEGER GENERATED ALWAYS AS (
    CASE WHEN meter_stop IS NOT NULL THEN meter_stop - meter_start ELSE NULL END
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_transactions_client  ON transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_started ON transactions(started_at DESC);

-- Dernière valeur connue par measurand (UPSERT à chaque MeterValues reçu, pas d'historique)
CREATE TABLE IF NOT EXISTS current_meter_values (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  client_id      TEXT NOT NULL,
  evse_id        INTEGER NOT NULL DEFAULT 0,
  connector_id   INTEGER NOT NULL,
  measurand      TEXT NOT NULL,  -- ex: 'Energy.Active.Import.Register', 'Power.Active.Import'
  value          REAL NOT NULL,
  unit           TEXT,           -- ex: 'Wh', 'W', 'A', 'V'
  UNIQUE(client_id, evse_id, connector_id, measurand)
);
CREATE INDEX IF NOT EXISTS idx_current_meter_client ON current_meter_values(client_id);

-- Autorisations RFID (Authorize & StartTransaction)
CREATE TABLE IF NOT EXISTS authorizations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  action         TEXT NOT NULL DEFAULT 'Authorize',
  ts             INTEGER NOT NULL,
  client_id      TEXT NOT NULL,
  id_tag         TEXT NOT NULL,
  token_type     TEXT DEFAULT 'ISO14443', -- ISO14443 | KeyCode | MacAddress…
  group_id_token TEXT, -- groupIdToken 2.0.1
  status         TEXT NOT NULL    -- 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx'
);
CREATE INDEX IF NOT EXISTS idx_authorizations_client ON authorizations(client_id);
CREATE INDEX IF NOT EXISTS idx_authorizations_tag    ON authorizations(id_tag);