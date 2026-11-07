# Obraz symulatora (usługa simulator, D45) — tylko do testów, dane SIMULATED.
# Kontekst budowania: katalog główny repozytorium. Włączany: sudo solargraf simulator on.

FROM ghcr.io/astral-sh/uv:0.13.5 AS uv

FROM python:3.12-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
COPY pyproject.toml uv.lock .python-version ./
COPY simulator ./simulator
COPY profiles-schema ./profiles-schema
# Tylko na potrzeby spójności workspace (uv sync --locked); nie trafiają do obrazu.
COPY server/pyproject.toml ./server/pyproject.toml
COPY agent/pyproject.toml ./agent/pyproject.toml
RUN uv sync --locked --no-dev --no-editable --package solargraf-simulator

FROM python:3.12-slim-trixie AS runtime
LABEL org.opencontainers.image.title="solargraf-simulator" \
      org.opencontainers.image.vendor="SolarGraf (nazwa robocza)" \
      com.solargraf.product="solargraf"
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY profiles/simulated.hybrid-inverter.yaml ./profiles/simulated.hybrid-inverter.yaml
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 5020
# Nasłuch na wszystkich interfejsach kontenera — port nie jest publikowany na hoście (D45).
CMD ["solargraf-sim", "/app/profiles/simulated.hybrid-inverter.yaml", "--host", "0.0.0.0", "--port", "5020"]
