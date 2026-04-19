FROM node:22-alpine3.22

LABEL org.opencontainers.image.title="ocpp-cp-proxyplus"
LABEL org.opencontainers.image.description="Bidirectional OCPP 1.6 WebSocket proxy with event-based alerts, email/push notifications and a web dashboard for charge point monitoring"
LABEL org.opencontainers.image.url="https://github.com/WoCha-FR/ocpp-cp-proxyplus"
LABEL org.opencontainers.image.source="https://github.com/WoCha-FR/ocpp-cp-proxyplus"
LABEL org.opencontainers.image.documentation="https://github.com/WoCha-FR/ocpp-cp-proxyplus#README.md"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
LABEL org.opencontainers.image.version="1.0.0"

WORKDIR /app
ENV NODE_ENV=production

# Utilisateur non-root pour la sécurité
RUN addgroup -S ocpp && adduser -S ocpp -G ocpp \
  && apk add --no-cache su-exec

# Installation des dependances
COPY --chown=ocpp:ocpp package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copie des sources
COPY --chown=ocpp:ocpp config ./config
COPY --chown=ocpp:ocpp lib/ ./lib/
COPY --chown=ocpp:ocpp locales ./locales
COPY --chown=ocpp:ocpp migrations ./migrations
COPY --chown=ocpp:ocpp public ./public
COPY --chown=ocpp:ocpp src/ ./src/

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Conserver une copie du contenu initial pour ensemencer les volumes montés vides au démarrage.
RUN mkdir -p /opt/defaults/config \
  && cp /app/config/config.sample.json /opt/defaults/config/config.sample.json \
  && mkdir -p /app/logs /app/locales-custom \
  && chown -R ocpp:ocpp /opt/defaults /app/locales-custom \
  && chown ocpp:ocpp /usr/local/bin/docker-entrypoint.sh \
  && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/config", "/app/locales-custom"]

EXPOSE 9000 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/healthz',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
