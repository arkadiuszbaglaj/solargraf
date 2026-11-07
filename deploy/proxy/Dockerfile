# Obraz proxy (D34): zbudowany frontend + Caddy. Kontekst budowania: katalog główny repozytorium.
# Wersje przypięte tagami; przypięcie digestami w P7.

FROM node:26-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM caddy:2.10.2-alpine AS runtime
LABEL org.opencontainers.image.title="solargraf-proxy" \
      org.opencontainers.image.vendor="SolarGraf (nazwa robocza)" \
      com.solargraf.product="solargraf"
COPY deploy/proxy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /web/dist /srv
