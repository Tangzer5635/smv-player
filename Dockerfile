# SMV Player — image du serveur (PC x86-64, Raspberry Pi arm64/armv7)
FROM node:22-bookworm-slim

# ffmpeg : transcodage HLS (iPhone, qualités réduites) · tini : signaux et processus ffmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# ffmpeg-static (optionnel) est inutile ici : ffmpeg vient du système
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /usr/local/bin/smv-entrypoint
RUN chmod 755 /usr/local/bin/smv-entrypoint

ENV SMV_DATA_DIR=/data \
    SMV_PORT=9191 \
    SMV_HOST=0.0.0.0
VOLUME /data
EXPOSE 9191

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9191/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "smv-entrypoint"]
CMD ["node", "server/index.js"]
