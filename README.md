# OCPP-CP-ProxyPlus

A bidirectional OCPP WebSocket proxy for EV charging stations, with real-time dashboard, event notifications, and SQLite-backed data storage.

## Overview

OCPP-CP-ProxyPlus sits between charge points (EV charging stations) and one or more upstream OCPP servers (CSMS). It transparently forwards OCPP messages in both directions while providing:

- Real-time monitoring dashboard
- Email and push notifications (Pushover) on key events
- Simultaneous connection to primary and secondary upstream servers, working as a pair
- Message buffering when upstream is temporarily unavailable
- SQLite database for events, transactions, faults, and authorizations

**Supported protocols:** OCPP 1.6 and OCPP 2.0.1

## Features

- **Bidirectional proxy** — routes messages between charge points and CSMS with automatic ID remapping
- **Dual upstream** — primary and secondary servers are connected simultaneously and work as a pair:
  - CALL from charge point → broadcast to both; only the primary's response is forwarded back (secondary's is dropped to avoid duplicates)
  - CALL from primary → forwarded to the charge point; the charge point's response is routed back to the primary
  - CALL from secondary → forwarded to the charge point; the charge point's response is routed back to the secondary
- **Buffering** — queues incoming messages when the primary is unavailable and flushes them on reconnect
- **Dashboard** — web UI with real-time updates via Server-Sent Events (SSE)
  - Status tab: live charger and connector states
  - Events tab: OCPP event log with filters
  - Transactions tab: charging session history with energy metrics
  - Configuration tab: live configuration editing
- **Remote commands** — Reset, Unlock Connector, Trigger Message, Get Diagnostics, Get Configuration
- **Notifications** — configurable alerts for connect/disconnect, faults, and transactions
- **Multi-language** — French and English UI support

## Requirements

- Node.js >= 18.0.0
- npm

## Installation

```bash
git clone https://github.com/WoCha-FR/ocpp-cp-proxyplus.git
cd ocpp-cp-proxyplus
npm install
cp config/config.sample.json config/config.json
```

Edit `config/config.json` to match your environment (see [Configuration](#configuration)).

## Running

```bash
# Production
npm start

# Development (with NODE_ENV=development, loads config/config.dev.json)
npm run start-dev
```

### Docker

```bash
docker build -t ocpp-cp-proxyplus .
docker run -p 9000:9000 -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  ocpp-cp-proxyplus
```

The Docker image exposes:

- **9000** — OCPP WebSocket proxy
- **3000** — HTTP dashboard

### Docker Compose

A `docker-compose.yml` is provided. Configuration is driven by a `.env` file — no need to edit `config.json` for common deployment settings.

```bash
cp .env.example .env
# Edit .env: set OCPP_UPSTREAM_PRIMARY and DASHBOARD_PASSWORD at minimum
docker compose up -d
```

The `config/` directory is mounted as a volume. On first start the entrypoint seeds it with `config.sample.json` if it is empty. Set `OCPP_UPSTREAM_PRIMARY` in `.env` to skip editing the file entirely.

See [Environment variable overrides](#environment-variable-overrides) for the full list of supported variables.

## Configuration

Copy `config/config.sample.json` to `config/config.json` and edit:

```json
{
  "logLevel": "info",
  "lang": "en",
  "maxBufferSize": 100,
  "callTimeoutMs": 30000,
  "heartbeatIntervalMs": 30000,
  "proxy": { "host": "0.0.0.0", "port": 9000 },
  "dashboard": { "port": 3000, "username": "admin", "password": "changeme" },
  "routing": {
    "default": ["ws://primary-csms:8080", "ws://secondary-csms:8080"],
    "STATION_001": ["ws://specific-csms:8080"]
  },
  "notify": {
    "onConnect": true,
    "onDisconnect": true,
    "onUpstreamConnect": false,
    "onUpstreamDisconnect": true,
    "onStatusFault": true,
    "onTransaction": false,
    "email": {
      "enabled": false,
      "from": "proxy@example.com",
      "to": "admin@example.com",
      "transport": { "host": "smtp.example.com", "port": 587, "auth": { "user": "", "pass": "" } }
    },
    "pushover": { "enabled": false, "token": "APP_TOKEN", "user": "USER_KEY" }
  }
}
```

### Key options

| Option                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `logLevel`            | Log verbosity: `error`, `warn`, `info`, `debug` |
| `lang`                | UI and notification language: `en` or `fr`      |
| `maxBufferSize`       | Max messages buffered while upstream is down    |
| `callTimeoutMs`       | OCPP call timeout in milliseconds               |
| `heartbeatIntervalMs` | WebSocket heartbeat interval in milliseconds    |
| `proxy.port`          | WebSocket proxy listening port (default: 9000)  |
| `dashboard.port`      | HTTP dashboard port (default: 3000)             |
| `routing.default`     | Required — one or two upstream CSMS URLs        |
| `routing.<stationId>` | Optional per-station upstream override          |

### Environment variable overrides

Deployment-specific values and secrets can be set via environment variables instead of editing `config.json`. Each variable patches a single config key after the file is loaded.

| Variable                  | Config path                           | Default  | Description                          |
| ------------------------- | ------------------------------------- | -------- | ------------------------------------ |
| `OCPP_UPSTREAM_PRIMARY`   | `routing.default[0]`                  | —        | Primary CSMS URL (required)          |
| `OCPP_UPSTREAM_SECONDARY` | `routing.default[1]`                  | —        | Mirror CSMS URL (optional)           |
| `PROXY_PORT`              | `proxy.port`                          | `9000`   | WebSocket proxy port                 |
| `DASHBOARD_PORT`          | `dashboard.port`                      | `3000`   | Dashboard port                       |
| `DASHBOARD_USERNAME`      | `dashboard.username`                  | `admin`  | Dashboard login                      |
| `DASHBOARD_PASSWORD`      | `dashboard.password`                  | —        | Dashboard password                   |
| `LOG_LEVEL`               | `logLevel`                            | `info`   | Log verbosity                        |
| `NOTIFY_EMAIL_ENABLED`    | `notify.email.enabled`                | `false`  | Enable email notifications           |
| `SMTP_USER`               | `notify.email.transport.auth.user`    | —        | SMTP login                           |
| `SMTP_PASS`               | `notify.email.transport.auth.pass`    | —        | SMTP password                        |
| `SMTP_FROM`               | `notify.email.from`                   | —        | Sender address                       |
| `SMTP_TO`                 | `notify.email.to`                     | —        | Recipient address                    |
| `NOTIFY_PUSHOVER_ENABLED` | `notify.pushover.enabled`             | `false`  | Enable Pushover notifications        |
| `NOTIFY_PUSHOVER_TOKEN`   | `notify.pushover.token`               | —        | Pushover app token                   |
| `NOTIFY_PUSHOVER_USER`    | `notify.pushover.user`                | —        | Pushover user key                    |

> **Note:** SMTP connection settings (`host`, `port`, `tls`, etc.) are part of the `email.transport` object passed directly to nodemailer and must be configured in `config.json`. Only credentials are overridable via env vars.

Charge points connect to the proxy using the URL:

```text
ws://<proxy-host>:9000/<station-id>
```

## Notifications

Notifications are sent via email and/or Pushover. Each event type can be enabled or disabled individually.

The `email.transport` object is passed directly to [nodemailer](https://nodemailer.com/). Supported transports:

- **SMTP** — [nodemailer.com/smtp/](https://nodemailer.com/smtp/)
- **Sendmail** — [nodemailer.com/transports/sendmail/](https://nodemailer.com/transports/sendmail/)
- **Well-known services** (Gmail, Outlook…) — [nodemailer.com/smtp/well-known/](https://nodemailer.com/smtp/well-known/)

| Event                  | Description                                   |
| ---------------------- | --------------------------------------------- |
| `onConnect`            | A charge point connected to the proxy         |
| `onDisconnect`         | A charge point disconnected                   |
| `onUpstreamConnect`    | Upstream CSMS connection established          |
| `onUpstreamDisconnect` | Upstream CSMS connection lost                 |
| `onStatusFault`        | A fault status was reported by a charge point |
| `onTransaction`        | A charging transaction started or stopped     |

## Localization

Built-in languages: **English** (`en`) and **French** (`fr`). The active language is set via `lang` in the configuration.

### Overriding translations or adding a language

Create a `locales-custom/` directory at the project root and place JSON files in it. The file name is the language code (e.g. `de.json`, `en.json`).

- **Override keys in an existing language** — create a file with the same language code as a built-in locale. Only the keys present in your file are overridden; the rest fall back to the built-in values (deep merge).
- **Add a new language** — create a file with a new language code. Set `lang` in the configuration to that code.

```text
locales-custom/
  en.json   ← overrides specific keys in the built-in English locale
  de.json   ← adds German as a new language
```

> **Note:** The dashboard fetches translations from `/api/locale/:lang`, which returns the fully merged locale. Custom files therefore apply to both **notification messages** and the **dashboard UI**.

## Architecture

```text
Charge Point ──ws──► Proxy ──ws──► Primary CSMS   (CALLs broadcast to both;
                       │                            only primary response relayed back)
                       └──ws──► Secondary CSMS
                       │
                     SQLite
                       │
                   HTTP Dashboard
```

**Core modules:**

| Module              | Role                                                         |
| ------------------- | ------------------------------------------------------------ |
| `proxy.js`          | WebSocket server, client lifecycle, protocol negotiation     |
| `upstream.js`       | Upstream connections with reconnect and exponential backoff  |
| `ocpp-router.js`    | Message routing and ID remapping                             |
| `notify.js`         | OCPP message parsing, event detection, notification dispatch |
| `http-server.js`    | REST API, SSE stream, remote command execution               |
| `store.js`          | SQLite data access layer (`config/cpproxy.db`)               |
| `command-sender.js` | Sends OCPP CALL messages to charge points                    |

## Development

```bash
# Watch mode
npm run test

# Linting
npm run lint
npm run fixlint

# Formatting
npm run prettier
npm run fixprettier
```

## Health check

The dashboard exposes a `/healthz` endpoint that returns HTTP 200 when the service is running.

## License

GPL-3.0-only
