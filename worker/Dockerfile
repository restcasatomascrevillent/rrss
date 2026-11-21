# syntax=docker/dockerfile:1
#
# Trabajador de medios: Node + FFmpeg. No depende de ningún alojamiento: es un
# contenedor que arranca, vacía la cola y termina (o se queda sondeando con
# WORKER_MODE=continuous).
#
#   docker build -t rrss-worker worker/                       # imagen de ejecución
#   docker build --target test -t rrss-worker-test worker/    # imagen con las pruebas
#
# Node ejecuta el TypeScript tal cual (eliminación de tipos, Node >= 22.18):
# no hay paso de compilación ni carpeta dist.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
# FFmpeg y ffprobe del repositorio de Alpine, usados como binarios externos, y
# una tipografía libre (DejaVu) para el texto de los vídeos.
RUN apk add --no-cache ffmpeg font-dejavu
ENV WORKER_FONT_FILE=/usr/share/fonts/dejavu/DejaVuSans.ttf \
    WORKER_TMP_DIR=/tmp/rrss-worker
WORKDIR /app
RUN chown node:node /app
USER node

# ── Pruebas dentro del contenedor (con dependencias de desarrollo) ─────────
FROM base AS test
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
CMD ["npm", "test"]

# ── Dependencias de ejecución ──────────────────────────────────────────────
FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── Imagen de ejecución: solo código, plantillas y dependencias ────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node templates ./templates
# Usuario sin privilegios (el `node` de la imagen oficial, uid 1000).
USER node
CMD ["node", "src/main.ts"]
