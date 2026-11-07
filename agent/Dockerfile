# Obraz agenta (usługa agent, D43). Kontekst budowania: katalog główny repozytorium.
# Agent jest jedynym klientem urządzeń; z API rozmawia w sieci Compose (http://api:8000).

FROM ghcr.io/astral-sh/uv:0.13.5 AS uv

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
COPY pyproject.toml uv.lock .python-version ./
COPY agent ./agent
COPY profiles-schema ./profiles-schema
# Tylko na potrzeby spójności workspace (uv sync --locked); nie trafiają do obrazu.
COPY server/pyproject.toml ./server/pyproject.toml
COPY simulator/pyproject.toml ./simulator/pyproject.toml
RUN uv sync --locked --no-dev --no-editable --package solargraf-agent

FROM python:3.12-slim-trixie AS runtime
LABEL org.opencontainers.image.title="solargraf-agent" \
      org.opencontainers.image.vendor="SolarGraf (nazwa robocza)" \
      com.solargraf.product="solargraf"
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/solargraf-agent
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY profiles ./profiles
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SOLARGRAF_PROFILES_DIR=/app/profiles \
    SOLARGRAF_AGENT_BUFFER=/var/lib/solargraf-agent/buffer.sqlite3
USER 10001:10001
VOLUME ["/var/lib/solargraf-agent"]
CMD ["solargraf-agent", "run"]
