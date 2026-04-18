class Store {
  constructor(db) {
    this.db = db
    this._stmtUpsertCP = db.prepare(`
      INSERT INTO chargepoints (client_id, vendor, model, serial, firmware, last_seen, first_seen)
      VALUES (@clientId, @vendor, @model, @serial, @firmware, @now, @now)
      ON CONFLICT(client_id) DO UPDATE SET
        vendor    = excluded.vendor,
        model     = excluded.model,
        serial    = excluded.serial,
        firmware  = excluded.firmware,
        last_seen = excluded.last_seen
    `)
    this._stmtTouchCP = db.prepare(`
      UPDATE chargepoints SET last_seen = @now WHERE client_id = @clientId
    `)
    this._stmtNameCP = db.prepare(`
      UPDATE chargepoints SET name = @name WHERE client_id = @clientId
    `)
    this._stmtUpsertStatus = db.prepare(`
      INSERT INTO connector_status (client_id, evse_id, connector_id, status, status_raw, error_code, updated_at)
      VALUES (@clientId, @evseId, @connectorId, @status, @statusRaw, @errorCode, @now)
      ON CONFLICT(client_id, evse_id, connector_id) DO UPDATE SET
        status     = excluded.status,
        status_raw = excluded.status_raw,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `)
    this._stmtInsertHistory = db.prepare(`
      INSERT INTO status_history (ts, client_id, evse_id, connector_id, status, status_raw, error_code)
      VALUES (@now, @clientId, @evseId, @connectorId, @status, @statusRaw, @errorCode)
    `)
    this._stmtInsertEvent = db.prepare(`
      INSERT INTO events (ts, type, client_id, evse_id, connector_id, payload)
      VALUES (@now, @type, @clientId, @evseId, @connectorId, @payload)
    `)
    this._stmtOpenTx = db.prepare(`
      INSERT INTO transactions (client_id, evse_id, connector_id, ocpp_tx_id, id_tag, meter_start, started_at, start_source)
      VALUES (@clientId, @evseId, @connectorId, @ocppTxId, @idTag, @meterStart, @startedAt, @startSource)
    `)
    this._stmtCloseTx = db.prepare(`
      UPDATE transactions SET meter_stop = @meterStop, stopped_at = @stoppedAt, stop_reason = @stopReason
      WHERE client_id = @clientId AND ocpp_tx_id = @ocppTxId AND stopped_at IS NULL
    `)
    this._stmtUpsertMV = db.prepare(`
      INSERT INTO current_meter_values (ts, client_id, evse_id, connector_id, measurand, value, unit)
      VALUES (@ts, @clientId, @evseId, @connectorId, @measurand, @value, @unit)
      ON CONFLICT(client_id, evse_id, connector_id, measurand) DO UPDATE SET
        ts    = excluded.ts,
        value = excluded.value,
        unit  = excluded.unit
    `)
    this._stmtInsertAuth = db.prepare(`
      INSERT INTO authorizations (ts, client_id, id_tag, token_type, group_id_token, status, action)
      VALUES (@now, @clientId, @idTag, @tokenType, @groupIdToken, @status, @action)
    `)
    this._stmtInsertFault = db.prepare(`
      INSERT INTO fault_events (ts, client_id, evse_id, connector_id, component, variable, error_code, severity, info, vendor_id, vendor_error, cleared, source)
      VALUES (@now, @clientId, @evseId, @connectorId, @component, @variable, @errorCode, @severity, @info, @vendorId, @vendorError, @cleared, @source)
    `)
  }

  upsertChargepoint(clientId, { vendor, model, serial, firmware } = {}) {
    this._stmtUpsertCP.run({
      clientId,
      vendor: vendor ?? null,
      model: model ?? null,
      serial: serial ?? null,
      firmware: firmware ?? null,
      now: Date.now(),
    })
  }

  touchChargepoint(clientId) {
    this._stmtTouchCP.run({ clientId, now: Date.now() })
  }

  updateChargepointName(clientId, name) {
    this._stmtNameCP.run({ clientId, name })
  }

  upsertConnectorStatus(clientId, evseId, connectorId, status, statusRaw = null, errorCode = null) {
    const now = Date.now()
    this._stmtUpsertStatus.run({ clientId, evseId, connectorId, status, statusRaw, errorCode, now })
    this._stmtInsertHistory.run({ clientId, evseId, connectorId, status, statusRaw, errorCode, now })
  }

  insertEvent(clientId, type, evseId = null, connectorId = null, payload = null) {
    this._stmtInsertEvent.run({
      now: Date.now(),
      type,
      clientId,
      evseId,
      connectorId,
      payload: payload !== null ? JSON.stringify(payload) : null,
    })
  }

  openTransaction(clientId, evseId, connectorId, ocppTxId, idTag, meterStart, startedAt, startSource = 'rfid') {
    this._stmtOpenTx.run({
      clientId,
      evseId,
      connectorId,
      ocppTxId: String(ocppTxId),
      idTag: idTag ?? null,
      meterStart: meterStart ?? null,
      startedAt,
      startSource,
    })
  }

  closeTransaction(clientId, ocppTxId, meterStop, stoppedAt, stopReason = null) {
    this._stmtCloseTx.run({ clientId, ocppTxId: String(ocppTxId), meterStop: meterStop ?? null, stoppedAt, stopReason })
  }

  // meterValueArray: OCPP meterValue array [{timestamp, sampledValue: [{measurand, value, unit}]}]
  upsertCurrentMeterValues(clientId, evseId, connectorId, meterValueArray) {
    for (const mv of meterValueArray) {
      const ts = mv.timestamp ? new Date(mv.timestamp).getTime() : Date.now()
      for (const sv of mv.sampledValue ?? []) {
        const numVal = parseFloat(sv.value)
        if (isNaN(numVal)) continue
        this._stmtUpsertMV.run({
          ts,
          clientId,
          evseId,
          connectorId,
          measurand: sv.measurand ?? 'Energy.Active.Import.Register',
          value: numVal,
          unit: sv.unitOfMeasure?.unit ?? sv.unit ?? null,
        })
      }
    }
  }

  insertAuthorization(clientId, idTag, status, tokenType = 'ISO14443', groupIdToken = null, action = 'Authorize') {
    this._stmtInsertAuth.run({ now: Date.now(), clientId, idTag, tokenType, groupIdToken, status, action })
  }

  insertFaultEvent(
    clientId,
    evseId,
    connectorId,
    { component, variable, errorCode, severity, info, vendorId, vendorError, cleared, source }
  ) {
    this._stmtInsertFault.run({
      now: Date.now(),
      clientId,
      evseId,
      connectorId,
      component: component ?? null,
      variable: variable ?? null,
      errorCode: errorCode ?? null,
      severity: severity ?? null,
      info: info ?? null,
      vendorId: vendorId ?? null,
      vendorError: vendorError ?? null,
      cleared: cleared ?? 0,
      source,
    })
  }

  getFaultEvents({ page = 1, limit = 50, clientId = null, cleared = null } = {}) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = {}
    if (clientId) {
      conditions.push('client_id = @clientId')
      params.clientId = clientId
    }
    if (cleared !== null && cleared !== undefined) {
      conditions.push('cleared = @cleared')
      params.cleared = cleared
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM fault_events ${where} ORDER BY ts DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset })
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM fault_events ${where}`).get(params)
    return { rows, total, page, limit }
  }

  getCurrentMeterValues(clientId = null) {
    if (clientId) {
      return this.db
        .prepare(`SELECT * FROM current_meter_values WHERE client_id = @clientId ORDER BY evse_id, connector_id, measurand`)
        .all({ clientId })
    }
    return this.db.prepare(`SELECT * FROM current_meter_values ORDER BY client_id, evse_id, connector_id, measurand`).all()
  }

  // --- Queries for the REST API ---

  getStatus() {
    return this.db
      .prepare(
        `
      SELECT cs.client_id, cs.evse_id, cs.connector_id, cs.status, cs.status_raw, cs.error_code, cs.updated_at,
             cp.name, (cs.connector_id = 0) AS is_station
      FROM connector_status cs
      LEFT JOIN chargepoints cp ON cp.client_id = cs.client_id
      ORDER BY cs.client_id, cs.evse_id, cs.connector_id
    `
      )
      .all()
  }

  getChargepoints() {
    return this.db
      .prepare(
        `
      SELECT * FROM chargepoints ORDER BY last_seen DESC
    `
      )
      .all()
  }

  getEvents({ page = 1, limit = 50, type = null, clientId = null } = {}) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = {}
    if (type) {
      conditions.push('type = @type')
      params.type = type
    }
    if (clientId) {
      conditions.push('client_id = @clientId')
      params.clientId = clientId
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `
      SELECT * FROM events ${where} ORDER BY ts DESC LIMIT @limit OFFSET @offset
    `
      )
      .all({ ...params, limit, offset })
    const { total } = this.db
      .prepare(
        `
      SELECT COUNT(*) AS total FROM events ${where}
    `
      )
      .get(params)
    return { rows, total, page, limit }
  }

  getTransactions({ page = 1, limit = 50, clientId = null } = {}) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = {}
    if (clientId) {
      conditions.push('t.client_id = @clientId')
      params.clientId = clientId
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `
      SELECT t.*, cp.name,
             CASE WHEN t.stopped_at IS NOT NULL THEN t.stopped_at - t.started_at ELSE NULL END AS duration_ms
      FROM transactions t
      LEFT JOIN chargepoints cp ON cp.client_id = t.client_id
      ${where}
      ORDER BY t.started_at DESC
      LIMIT @limit OFFSET @offset
    `
      )
      .all({ ...params, limit, offset })
    const { total } = this.db
      .prepare(
        `
      SELECT COUNT(*) AS total FROM transactions t ${where}
    `
      )
      .get(params)
    return { rows, total, page, limit }
  }
}

module.exports = Store
