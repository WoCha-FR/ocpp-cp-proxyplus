const Mailer = require('../lib/mailer')
const Pushover = require('../lib/pushover')
const { createLogger } = require('./logger')
const { trad } = require('./i18n')
const Store = require('./store')
const eventBus = require('./event-bus')

// Extract energy Wh from a meterValue array. Per OCPP spec, absent measurand defaults to Energy.Active.Import.Register.
function _extractEnergyWh(meterValueArray) {
  if (!meterValueArray?.length) return null
  for (const mv of meterValueArray) {
    for (const sv of mv.sampledValue ?? []) {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register'
      if (measurand === 'Energy.Active.Import.Register') {
        const v = parseFloat(sv.value)
        if (!isNaN(v)) return v
      }
    }
  }
  return null
}

// OCPP 2.0.1 triggerReason → start_source
function _triggerReasonToSource(reason) {
  if (reason === 'RemoteStart') return 'remote'
  if (reason === 'CablePluggedIn' || reason === 'PoweredUp' || reason === 'EVConnectTimeout') return 'local'
  return 'rfid'
}

// OCPP 2.0.1 chargingState → normalised OCPP 1.6-style status
const CHARGING_STATE_TO_STATUS = {
  Charging: 'Charging',
  EVConnected: 'Preparing',
  SuspendedEV: 'SuspendedEV',
  SuspendedEVSE: 'SuspendedEVSE',
  Idle: 'Finishing',
}

class Notify {
  constructor(config, db = null) {
    this.config = config
    this.store = db ? new Store(db) : null
    this.mailer = null
    this.pushover = null
    this.pendingStartTx = new Map() // messageId → {clientId,evseId,connectorId,idTag,meterStart,ts,startSource}
    this.pendingAuthorize = new Map() // messageId → {clientId,idTag,tokenType,groupIdToken}
    this.pendingTxEventAuth = new Map() // messageId → {clientId,idTag,tokenType,groupIdToken,startSource}
    this.pendingRemoteStart = new Map() // "clientId:connectorId" → {idTag,ts} (connectorId=0 = wildcard)
    this.log = createLogger('Notify')
    this._initTransports()
  }

  _initTransports() {
    const cfg = this.config
    this.mailer = null
    this.pushover = null

    if (cfg.email?.enabled && cfg.email.transport) {
      try {
        this.mailer = new Mailer({ from: cfg.email.from, to: cfg.email.to, transporter: cfg.email.transport })
        this.log.info('Email notifications enabled')
      } catch (err) {
        this.log.error(`Failed to init email: ${err.message}`)
      }
    }

    if (cfg.pushover?.enabled && cfg.pushover.token && cfg.pushover.user) {
      try {
        this.pushover = new Pushover({ userKey: cfg.pushover.user, appToken: cfg.pushover.token })
        this.log.info('Pushover notifications enabled')
      } catch (err) {
        this.log.error(`Failed to init pushover: ${err.message}`)
      }
    }
  }

  reload() {
    this._initTransports()
  }

  clearPending(clientId) {
    for (const [key, val] of this.pendingStartTx) {
      if (val.clientId === clientId) this.pendingStartTx.delete(key)
    }
    for (const [key, val] of this.pendingAuthorize) {
      if (val.clientId === clientId) this.pendingAuthorize.delete(key)
    }
    for (const [key, val] of this.pendingTxEventAuth) {
      if (val.clientId === clientId) this.pendingTxEventAuth.delete(key)
    }
    for (const key of this.pendingRemoteStart.keys()) {
      if (key.startsWith(`${clientId}:`)) this.pendingRemoteStart.delete(key)
    }
  }

  // ─── Public API called by proxy.js ───────────────────────────────────────

  connectedToProxy(clientId) {
    this.store?.registerChargepoint(clientId)
    this.store?.insertEvent(clientId, 'connected_proxy')
    eventBus.emit('client-connected', { clientId })
    eventBus.emit('ocpp-event', { type: 'connected_proxy', clientId })
    if (!this.config.onConnect) return
    this._send(trad('notification.connected.title', { clientId }), trad('notification.connected.body', { clientId }))
  }

  disconnectedFromProxy(clientId) {
    this.store?.insertEvent(clientId, 'disconnected_proxy')
    eventBus.emit('client-disconnected', { clientId })
    eventBus.emit('ocpp-event', { type: 'disconnected_proxy', clientId })
    if (!this.config.onDisconnect) return
    this._send(trad('notification.disconnected.title', { clientId }), trad('notification.disconnected.body', { clientId }))
  }

  connectedToUpstream(clientId, serverName) {
    if (!this.config.onUpstreamConnect) return
    this._send(
      trad('notification.upstream_connected.title', { clientId, serverName }),
      trad('notification.upstream_connected.body', { clientId, serverName })
    )
  }

  disconnectedFromUpstream(clientId, serverName) {
    if (!this.config.onUpstreamDisconnect) return
    this._send(
      trad('notification.upstream_disconnected.title', { clientId, serverName }),
      trad('notification.upstream_disconnected.body', { clientId, serverName })
    )
  }

  upstreamRejected(clientId, serverName, statusCode) {
    this.store?.insertEvent(clientId, 'upstream_rejected', null, null, { serverName, statusCode })
    eventBus.emit('ocpp-event', { type: 'upstream_rejected', clientId })
    if (!this.config.onUpstreamDisconnect) return
    this._send(
      trad('notification.upstream_rejected.title', { clientId, serverName }),
      trad('notification.upstream_rejected.body', { clientId, serverName, statusCode })
    )
  }

  // ─── CALL from client (type 2) ────────────────────────────────────────────

  callFromClient(clientId, data) {
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(parsed) || parsed[0] !== 2) return

    const [, messageId, action, params = {}] = parsed
    const now = Date.now()

    switch (action) {
      case 'BootNotification':
        this._handleBootNotification(clientId, params)
        break
      case 'StatusNotification':
        this._handleStatusNotification(clientId, params)
        break
      case 'StartTransaction':
        this._handleStartTransaction(clientId, messageId, params, now)
        break
      case 'StopTransaction':
        this._handleStopTransaction(clientId, params, now)
        break
      case 'MeterValues':
        this._handleMeterValues(clientId, params)
        break
      case 'Authorize':
        this._handleAuthorize(clientId, messageId, params)
        break
      case 'Heartbeat':
        this.store?.touchChargepoint(clientId)
        break
      case 'TransactionEvent':
        this._handleTransactionEvent(clientId, messageId, params, now)
        break
      case 'NotifyEvent':
        this._handleNotifyEvent(clientId, params)
        break
    }
  }

  // ─── CALLRESULT from upstream (type 3) ────────────────────────────────────

  callResultFromUpstream(clientId, messageId, parsed) {
    const payload = parsed[2] ?? {}

    const startPending = this.pendingStartTx.get(messageId)
    if (startPending) {
      this.pendingStartTx.delete(messageId)
      const ocppTxId = payload.transactionId
      const authStatus = payload.idTagInfo?.status ?? 'Accepted'
      if (startPending.idTag && this.store) {
        this.store.insertAuthorization(
          startPending.clientId,
          startPending.idTag,
          authStatus,
          'ISO14443',
          null,
          'StartTransaction'
        )
      }
      if (ocppTxId != null && authStatus === 'Accepted' && this.store) {
        this.store.openTransaction(
          startPending.clientId,
          startPending.evseId,
          startPending.connectorId,
          ocppTxId,
          startPending.idTag,
          startPending.meterStart,
          startPending.ts,
          startPending.startSource
        )
        this.store.insertEvent(startPending.clientId, 'start_transaction', startPending.evseId, startPending.connectorId, {
          ocppTxId,
          idTag: startPending.idTag,
        })
        eventBus.emit('transaction-open', {
          clientId: startPending.clientId,
          evseId: startPending.evseId,
          connectorId: startPending.connectorId,
          ocppTxId,
        })
        if (this.config.onTransaction) {
          this._send(
            trad('notification.transaction_start.title', { clientId }),
            trad('notification.transaction_start.body', {
              clientId,
              connectorId: startPending.connectorId,
              idTag: startPending.idTag ?? '',
            })
          )
        }
      }
      return
    }

    const authPending = this.pendingAuthorize.get(messageId)
    if (authPending) {
      this.pendingAuthorize.delete(messageId)
      // OCPP 1.6 uses idTagInfo, OCPP 2.0.1 uses idTokenInfo
      const status = payload.idTagInfo?.status ?? payload.idTokenInfo?.status ?? 'Invalid'
      this.store?.insertAuthorization(
        authPending.clientId,
        authPending.idTag,
        status,
        authPending.tokenType,
        authPending.groupIdToken,
        'Authorize'
      )
      this.store?.insertEvent(authPending.clientId, 'authorize', null, null, { idTag: authPending.idTag, status })
      eventBus.emit('ocpp-event', { type: 'authorize', clientId: authPending.clientId })
      return
    }

    const txEventAuth = this.pendingTxEventAuth.get(messageId)
    if (txEventAuth) {
      this.pendingTxEventAuth.delete(messageId)
      const authStatus = payload.idTokenInfo?.status ?? 'Accepted'
      this.store?.insertAuthorization(
        txEventAuth.clientId,
        txEventAuth.idTag,
        authStatus,
        txEventAuth.tokenType,
        txEventAuth.groupIdToken,
        'TransactionEvent'
      )
      if (authStatus === 'Accepted' && this.store) {
        this.store.openTransaction(
          txEventAuth.clientId,
          txEventAuth.evseId,
          txEventAuth.connectorId,
          txEventAuth.ocppTxId,
          txEventAuth.idTag,
          txEventAuth.meterStart,
          txEventAuth.ts,
          txEventAuth.startSource
        )
        this.store.insertEvent(txEventAuth.clientId, 'transaction_event', txEventAuth.evseId, txEventAuth.connectorId, {
          eventType: 'Started',
          ocppTxId: txEventAuth.ocppTxId,
          idTag: txEventAuth.idTag,
        })
        eventBus.emit('transaction-open', {
          clientId: txEventAuth.clientId,
          evseId: txEventAuth.evseId,
          connectorId: txEventAuth.connectorId,
          ocppTxId: txEventAuth.ocppTxId,
        })
        if (this.config.onTransaction) {
          this._send(
            trad('notification.transaction_start.title', { clientId: txEventAuth.clientId }),
            trad('notification.transaction_start.body', {
              clientId: txEventAuth.clientId,
              connectorId: txEventAuth.connectorId,
              idTag: txEventAuth.idTag,
            })
          )
        }
      }
    }
  }

  // ─── CALL from upstream (type 2) ─────────────────────────────────────────

  callFromUpstream(clientId, message) {
    if (message.type !== 2) return
    const [, , action, params = {}] = message.parsed

    switch (action) {
      case 'GetConfiguration':
      case 'GetVariables':
        this.store?.insertEvent(clientId, 'get_configuration', null, null, params)
        break
      case 'RemoteStartTransaction': {
        const connectorId = params.connectorId ?? 0
        const key = `${clientId}:${connectorId}`
        this.pendingRemoteStart.set(key, { idTag: params.idTag ?? null, ts: Date.now() })
        break
      }
    }
  }

  // ─── Private handlers ─────────────────────────────────────────────────────

  _handleBootNotification(clientId, params) {
    // OCPP 1.6: flat fields; OCPP 2.0.1: nested under chargingStation
    const cs = params.chargingStation
    this.store?.upsertChargepoint(clientId, {
      vendor: cs?.vendorName ?? params.chargePointVendor,
      model: cs?.model ?? params.chargePointModel,
      serial: cs?.serialNumber ?? params.chargePointSerialNumber,
      firmware: cs?.firmwareVersion ?? params.firmwareVersion,
    })
    this.store?.insertEvent(clientId, 'boot_notification', null, null, params)
    eventBus.emit('ocpp-event', { type: 'boot_notification', clientId })
  }

  _handleStatusNotification(clientId, params) {
    // OCPP 1.6: connectorId / status / errorCode
    // OCPP 2.0.1: evseId / connectorId / connectorStatus
    const evseId = params.evseId ?? 0
    const connectorId = params.connectorId ?? 0
    let status, statusRaw, errorCode

    if (params.connectorStatus !== undefined) {
      statusRaw = params.connectorStatus
      status = statusRaw === 'Occupied' ? 'Charging' : statusRaw
      errorCode = null
    } else {
      status = params.status ?? 'Unknown'
      statusRaw = null
      errorCode = params.errorCode ?? null
    }

    this.store?.upsertConnectorStatus(clientId, evseId, connectorId, status, statusRaw, errorCode)
    this.store?.insertEvent(clientId, 'status_notification', evseId, connectorId, params)
    eventBus.emit('status-update', { clientId, evseId, connectorId, status })
    eventBus.emit('ocpp-event', { type: 'status_notification', clientId })

    const isFaulted = status === 'Faulted'
    const hasError = errorCode && errorCode !== 'NoError'
    if (isFaulted || hasError) {
      const severity = isFaulted && hasError ? 2 : isFaulted ? 3 : 5
      const component = connectorId === 0 ? 'ChargingStation' : 'Connector'
      this._insertFaultAndNotify(clientId, evseId, connectorId, {
        component,
        variable: null,
        errorCode: errorCode ?? null,
        severity,
        info: params.info ?? null,
        vendorId: params.vendorId ?? null,
        vendorError: params.vendorErrorCode ?? null,
        cleared: 0,
        source: 'ocpp16',
      })
    } else {
      const cleared = this.store?.clearFaultEvents(clientId, evseId, connectorId) ?? 0
      if (cleared > 0) {
        eventBus.emit('fault-cleared', { clientId, evseId, connectorId })
      }
    }
  }

  _handleStartTransaction(clientId, messageId, params, now) {
    const connectorId = params.connectorId ?? 0
    const specificKey = `${clientId}:${connectorId}`
    const wildcardKey = `${clientId}:0`
    let startSource = 'rfid'
    if (this.pendingRemoteStart.has(specificKey)) {
      startSource = 'remote'
      this.pendingRemoteStart.delete(specificKey)
    } else if (connectorId !== 0 && this.pendingRemoteStart.has(wildcardKey)) {
      startSource = 'remote'
      this.pendingRemoteStart.delete(wildcardKey)
    }
    this.pendingStartTx.set(messageId, {
      clientId,
      evseId: 0,
      connectorId,
      idTag: params.idTag ?? null,
      meterStart: params.meterStart ?? null,
      ts: now,
      startSource,
    })
  }

  _handleStopTransaction(clientId, params, now) {
    // No guard on connectorId (fix per plan)
    const ocppTxId = params.transactionId
    const meterStop = params.meterStop ?? null
    const stopReason = params.reason ?? null

    const connectorId = params.connectorId ?? 0
    if (this.store) {
      this.store.closeTransaction(clientId, ocppTxId, meterStop, now, stopReason)
      this.store.insertEvent(clientId, 'stop_transaction', 0, connectorId, { ocppTxId, meterStop, stopReason })
      if (params.transactionData) {
        this.store.upsertCurrentMeterValues(clientId, 0, connectorId, params.transactionData)
      }
      this.store.clearTransientMeterValues(clientId, 0, connectorId)
      eventBus.emit('meter-values-update', { clientId })
    }
    eventBus.emit('transaction-close', { clientId, evseId: 0, connectorId, ocppTxId })

    if (this.config.onTransaction) {
      this._send(
        trad('notification.transaction_stop.title', { clientId }),
        trad('notification.transaction_stop.body', { clientId, connectorId: params.connectorId ?? '' })
      )
    }
  }

  _handleMeterValues(clientId, params) {
    const evseId = params.evseId ?? 0
    const connectorId = params.connectorId ?? 0
    if (this.store && params.meterValue) {
      this.store.upsertCurrentMeterValues(clientId, evseId, connectorId, params.meterValue)
      this.store.insertEvent(clientId, 'meter_values', evseId, connectorId, params)
      eventBus.emit('meter-values-update', { clientId })
      eventBus.emit('ocpp-event', { type: 'meter_values', clientId })
    }
  }

  _handleAuthorize(clientId, messageId, params) {
    // OCPP 1.6: params.idTag
    // OCPP 2.0.1: params.idToken.idToken, params.idToken.type, params.groupIdToken
    const idTag = params.idTag ?? params.idToken?.idToken
    const tokenType = params.idToken?.type ?? 'ISO14443'
    const groupIdToken = params.groupIdToken?.idToken ?? null
    if (idTag) {
      this.pendingAuthorize.set(messageId, { clientId, idTag, tokenType, groupIdToken })
    }
  }

  _handleTransactionEvent(clientId, messageId, params, now) {
    const eventType = params.eventType // Started | Updated | Ended
    const evseId = params.evse?.id ?? 0
    const connectorId = params.evse?.connectorId ?? 0
    const ocppTxId = params.transactionInfo?.transactionId ?? null
    const idTag = params.idToken?.idToken ?? null

    switch (eventType) {
      case 'Started': {
        const meterStart = _extractEnergyWh(params.meterValue)
        const startSource = _triggerReasonToSource(params.triggerReason)
        if (idTag) {
          // Defer openTransaction until the CSMS response confirms idTokenInfo.status
          this.pendingTxEventAuth.set(messageId, {
            clientId,
            evseId,
            connectorId,
            ocppTxId,
            idTag,
            meterStart,
            ts: now,
            tokenType: params.idToken?.type ?? 'ISO14443',
            groupIdToken: params.groupIdToken?.idToken ?? null,
            startSource,
          })
        } else {
          // Anonymous / offline transaction — no auth to check
          this.store?.openTransaction(clientId, evseId, connectorId, ocppTxId, null, meterStart, now, startSource)
          this.store?.insertEvent(clientId, 'transaction_event', evseId, connectorId, { eventType, ocppTxId, idTag })
          eventBus.emit('transaction-open', { clientId, evseId, connectorId, ocppTxId })
          if (this.config.onTransaction) {
            this._send(
              trad('notification.transaction_start.title', { clientId }),
              trad('notification.transaction_start.body', { clientId, connectorId, idTag: '' })
            )
          }
        }
        break
      }

      case 'Updated': {
        const chargingState = params.chargingState ?? null
        if (chargingState) {
          const status = CHARGING_STATE_TO_STATUS[chargingState] ?? chargingState
          this.store?.upsertConnectorStatus(clientId, evseId, connectorId, status, chargingState, null)
          eventBus.emit('status-update', { clientId, evseId, connectorId, status })
        }
        if (params.meterValue && this.store) {
          this.store.upsertCurrentMeterValues(clientId, evseId, connectorId, params.meterValue)
          eventBus.emit('meter-values-update', { clientId })
        }
        this.store?.insertEvent(clientId, 'transaction_event', evseId, connectorId, {
          eventType,
          ocppTxId,
          chargingState: params.chargingState,
        })
        eventBus.emit('ocpp-event', { type: 'transaction_event', clientId })
        break
      }

      case 'Ended': {
        const meterStop = _extractEnergyWh(params.meterValue)
        const stopReason = params.stoppedReason ?? params.triggerReason ?? null
        this.store?.closeTransaction(clientId, ocppTxId, meterStop, now, stopReason)
        this.store?.upsertConnectorStatus(clientId, evseId, connectorId, 'Available', null, null)
        this.store?.insertEvent(clientId, 'transaction_event', evseId, connectorId, { eventType, ocppTxId, stopReason })
        if (this.store) {
          this.store.clearTransientMeterValues(clientId, evseId, connectorId)
          eventBus.emit('meter-values-update', { clientId })
        }
        eventBus.emit('transaction-close', { clientId, evseId, connectorId, ocppTxId })
        eventBus.emit('status-update', { clientId, evseId, connectorId, status: 'Available' })
        eventBus.emit('ocpp-event', { type: 'transaction_event', clientId })
        if (this.config.onTransaction) {
          this._send(
            trad('notification.transaction_stop.title', { clientId }),
            trad('notification.transaction_stop.body', { clientId, connectorId })
          )
        }
        break
      }
    }
  }

  _insertFaultAndNotify(clientId, evseId, connectorId, faultFields) {
    this.store?.insertFaultEvent(clientId, evseId, connectorId, faultFields)
    eventBus.emit('fault-event', { clientId, evseId, connectorId, ...faultFields, ts: Date.now() })
    if (faultFields.severity <= 3 && this.config.onStatusFault) {
      this._send(
        trad('notification.fault.title', { clientId }),
        trad('notification.fault.body', {
          clientId,
          connectorId,
          errorCode: faultFields.errorCode ?? faultFields.vendorError ?? '',
          componentStr: faultFields.component ? `\nComposant : ${faultFields.component}` : '',
          severityStr: faultFields.severity != null ? `\nSévérité : ${faultFields.severity}` : '',
          infoStr: faultFields.info ? `\nInfo : ${faultFields.info}` : '',
        })
      )
    }
  }

  _handleNotifyEvent(clientId, params) {
    for (const eventData of params.eventData ?? []) {
      const evseId = eventData.component?.evse?.id ?? 0
      const connectorId = eventData.component?.evse?.connectorId ?? 0
      this._insertFaultAndNotify(clientId, evseId, connectorId, {
        component: eventData.component?.name ?? null,
        variable: eventData.variable?.name ?? null,
        errorCode: eventData.techCode ?? null,
        severity: eventData.severity ?? null,
        info: eventData.techInfo ?? null,
        vendorId: null,
        vendorError: eventData.actualValue ?? null,
        cleared: eventData.cleared ? 1 : 0,
        source: 'ocpp201',
      })
    }
  }

  _send(title, message) {
    if (this.mailer) {
      this.mailer
        .send(title, message)
        .then((res) => {
          if (res.error) this.log.error(`Email notification failed: ${res.error}`)
          else this.log.debug('Email notification sent')
        })
        .catch((err) => this.log.error(`Email notification error: ${err.message}`))
    }
    if (this.pushover) {
      this.pushover
        .send(title, message)
        .then((res) => {
          if (res.error) this.log.error(`Pushover notification failed: ${res.error}`)
          else this.log.debug('Pushover notification sent')
        })
        .catch((err) => this.log.error(`Pushover notification error: ${err.message}`))
    }
  }
}

module.exports = Notify
