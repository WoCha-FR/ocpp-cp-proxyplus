# OCPP-CP-ProxyPlus

Un proxy WebSocket OCPP bidirectionnel pour bornes de recharge électrique, avec tableau de bord temps réel, notifications d'événements et stockage de données SQLite.

## Présentation

OCPP-CP-ProxyPlus se place entre les bornes de recharge et un ou plusieurs serveurs OCPP amont (CSMS). Il transfère les messages OCPP de façon transparente dans les deux sens, tout en offrant :

- Un tableau de bord de supervision en temps réel
- Des notifications par e-mail et push (Pushover) sur les événements clés
- Une connexion simultanée aux serveurs primaire et secondaire, fonctionnant en paire
- Une mise en tampon des messages en cas d'indisponibilité du serveur amont
- Une base de données SQLite pour les événements, transactions, défauts et autorisations

**Protocoles supportés :** OCPP 1.6 et OCPP 2.0.1

## Fonctionnalités

- **Proxy bidirectionnel** — achemine les messages entre bornes et CSMS avec remappage automatique des identifiants
- **Double serveur amont** — les serveurs primaire et secondaire sont connectés simultanément et fonctionnent en paire :
  - CALL de la borne → diffusé aux deux ; seule la réponse du primaire est retransmise à la borne (celle du secondaire est ignorée pour éviter les doublons)
  - CALL du primaire → transmis à la borne ; la réponse de la borne est renvoyée au primaire
  - CALL du secondaire → transmis à la borne ; la réponse de la borne est renvoyée au secondaire
- **Tampon de messages** — met en file les messages entrants lorsque le primaire est indisponible et les transmet à la reconnexion
- **Tableau de bord** — interface web avec mises à jour en temps réel via Server-Sent Events (SSE)
  - Onglet Statut : état en direct des bornes et connecteurs
  - Onglet Événements : journal OCPP avec filtres
  - Onglet Transactions : historique des sessions de charge avec métriques énergétiques
  - Onglet Configuration : édition de la configuration en direct
- **Commandes à distance** — Reset, Déverrouillage connecteur, Déclenchement message, Diagnostics, Lecture configuration
- **Notifications** — alertes configurables sur connexion/déconnexion, défauts et transactions
- **Multi-langue** — interface disponible en français et en anglais

## Prérequis

- Node.js >= 18.0.0
- npm

## Installation

```bash
git clone https://github.com/WoCha-FR/ocpp-cp-proxyplus.git
cd ocpp-cp-proxyplus
npm install
cp config/config.sample.json config/config.json
```

Éditez `config/config.json` selon votre environnement (voir [Configuration](#configuration)).

## Démarrage

```bash
# Production
npm start

# Développement (avec NODE_ENV=development, charge config/config.dev.json)
npm run start-dev
```

### Docker

```bash
docker build -t ocpp-cp-proxyplus .
docker run -p 9000:9000 -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  ocpp-cp-proxyplus
```

L'image Docker expose :

- **9000** — Proxy WebSocket OCPP
- **3000** — Tableau de bord HTTP

## Configuration

Copiez `config/config.sample.json` vers `config/config.json` et adaptez :

```json
{
  "logLevel": "info",
  "lang": "fr",
  "maxBufferSize": 100,
  "callTimeoutMs": 30000,
  "heartbeatIntervalMs": 30000,
  "proxy": { "host": "0.0.0.0", "port": 9000 },
  "dashboard": { "port": 3000, "username": "admin", "password": "changeme" },
  "routing": {
    "default": ["ws://csms-primaire:8080", "ws://csms-secondaire:8080"],
    "BORNE_001": ["ws://csms-specifique:8080"]
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
      "from": "proxy@exemple.fr",
      "to": "admin@exemple.fr",
      "transport": { "host": "smtp.exemple.fr", "port": 587, "auth": { "user": "", "pass": "" } }
    },
    "pushover": { "enabled": false, "token": "TOKEN_APP", "user": "CLE_USER" }
  }
}
```

### Options principales

| Option                | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `logLevel`            | Verbosité des logs : `error`, `warn`, `info`, `debug`              |
| `lang`                | Langue de l'interface et des notifications : `fr` ou `en`          |
| `maxBufferSize`       | Nombre maximum de messages mis en tampon pendant une coupure amont |
| `callTimeoutMs`       | Délai d'attente des appels OCPP en millisecondes                   |
| `heartbeatIntervalMs` | Intervalle de heartbeat WebSocket en millisecondes                 |
| `proxy.port`          | Port d'écoute du proxy WebSocket (défaut : 9000)                   |
| `dashboard.port`      | Port du tableau de bord HTTP (défaut : 3000)                       |
| `routing.default`     | Obligatoire — un ou deux URLs CSMS amont                           |
| `routing.<stationId>` | Optionnel — routage spécifique par identifiant de borne            |

Les bornes se connectent au proxy avec l'URL :

```text
ws://<hôte-proxy>:9000/<identifiant-borne>
```

## Notifications

Les notifications sont envoyées par e-mail et/ou Pushover. Chaque type d'événement peut être activé ou désactivé indépendamment.

L'objet `email.transport` est transmis directement à [nodemailer](https://nodemailer.com/). Transports supportés :

- **SMTP** — [nodemailer.com/smtp/](https://nodemailer.com/smtp/)
- **Sendmail** — [nodemailer.com/transports/sendmail/](https://nodemailer.com/transports/sendmail/)
- **Services préconfigurés** (Gmail, Outlook…) — [nodemailer.com/smtp/well-known/](https://nodemailer.com/smtp/well-known/)

| Événement              | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `onConnect`            | Une borne s'est connectée au proxy                    |
| `onDisconnect`         | Une borne s'est déconnectée                           |
| `onUpstreamConnect`    | Connexion au CSMS amont établie                       |
| `onUpstreamDisconnect` | Connexion au CSMS amont perdue                        |
| `onStatusFault`        | Un défaut a été signalé par une borne                 |
| `onTransaction`        | Une transaction de charge a démarré ou s'est terminée |

## Localisation

Langues intégrées : **Français** (`fr`) et **Anglais** (`en`). La langue active est définie via `lang` dans la configuration.

### Surcharger les traductions ou ajouter une langue

Créez un répertoire `locales-custom/` à la racine du projet et placez-y des fichiers JSON. Le nom du fichier correspond au code de langue (ex. `de.json`, `en.json`).

- **Surcharger des clés d'une langue existante** — créez un fichier avec le même code qu'une locale intégrée. Seules les clés présentes dans votre fichier sont remplacées ; les autres conservent leur valeur d'origine (fusion profonde).
- **Ajouter une nouvelle langue** — créez un fichier avec un nouveau code de langue. Définissez `lang` dans la configuration avec ce code.

```text
locales-custom/
  fr.json   ← surcharge des clés spécifiques de la locale française intégrée
  de.json   ← ajoute l'allemand comme nouvelle langue
```

> **Note :** Le tableau de bord charge ses traductions via `/api/locale/:lang`, qui retourne la locale entièrement fusionnée. Les fichiers personnalisés s'appliquent donc aussi bien aux **messages de notification** qu'à **l'interface du tableau de bord**.

## Architecture

```text
Borne de recharge ──ws──► Proxy ──ws──► CSMS Primaire   (CALLs diffusés aux deux ;
                            │                             seule la réponse du primaire
                            └──ws──► CSMS Secondaire      est retransmise à la borne)
                            │
                          SQLite
                            │
                      Tableau de bord HTTP
```

**Modules principaux :**

| Module              | Rôle                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `proxy.js`          | Serveur WebSocket, cycle de vie des clients, négociation de protocole     |
| `upstream.js`       | Connexions amont avec reconnexion et backoff exponentiel                  |
| `ocpp-router.js`    | Routage des messages et remappage des identifiants                        |
| `notify.js`         | Analyse des messages OCPP, détection d'événements, envoi de notifications |
| `http-server.js`    | API REST, flux SSE, exécution de commandes à distance                     |
| `store.js`          | Couche d'accès aux données SQLite (`config/cpproxy.db`)                   |
| `command-sender.js` | Envoi de messages OCPP CALL vers les bornes                               |

## Développement

```bash
# Mode watch
npm run test

# Lint
npm run lint
npm run fixlint

# Formatage
npm run prettier
npm run fixprettier
```

## Vérification de l'état

Le tableau de bord expose un endpoint `/healthz` qui renvoie HTTP 200 lorsque le service est opérationnel.

## Licence

GPL-3.0-only
