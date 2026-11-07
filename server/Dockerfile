# Obraz API i migracji (usługi api, migrate). Kontekst budowania: katalog główny repozytorium.
# Wersje przypięte tagami; przypięcie digestami i obrazy multi-arch w P7.

FROM ghcr.io/astral-sh/uv:0.13.5 AS uv

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
COPY pyproject.toml uv.lock .python-version ./
COPY server ./server
COPY agent ./agent
COPY profiles-schema ./profiles-schema
# Tylko na potrzeby spójności workspace (uv sync --locked); nie trafia do obrazu.
COPY simulator/pyproject.toml ./simulator/pyproject.toml
RUN uv sync --locked --no-dev --no-editable --package solargraf-server

FROM python:3.12-slim-trixie AS runtime
LABEL org.opencontainers.image.title="solargraf-api" \
      org.opencontainers.image.vendor="SolarGraf (nazwa robocza)" \
      com.solargraf.product="solargraf"
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY server/alembic.ini ./alembic.ini
COPY server/alembic ./alembic
# Katalog profili (D44) — ten sam co w obrazie agenta.
COPY profiles ./profiles
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SOLARGRAF_PROFILES_DIR=/app/profiles
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2).status == 200 else 1)"]
CMD ["uvicorn", "solargraf_server.main:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
