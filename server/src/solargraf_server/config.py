"""Konfiguracja serwera ze zmiennych środowiskowych (prefiks ``SOLARGRAF_``)."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SOLARGRAF_", extra="ignore")

    db_host: str = "localhost"
    db_port: int = Field(default=5432, ge=1, le=65535)
    db_name: str = "solargraf"
    db_user: str = "solargraf"
    db_password: SecretStr
    # Limit czasu połączenia i sprawdzenia gotowości bazy [s].
    db_timeout_s: float = Field(default=2.0, gt=0, le=30)
    # Swagger UI i /api/openapi.json — tylko w środowisku deweloperskim.
    api_docs: bool = False
    # Sesje (D30). `Secure` wyłączać wyłącznie w dev bez TLS.
    session_cookie_secure: bool = True
    session_idle_hours: float = Field(default=24, gt=0, le=24 * 30)
    session_absolute_days: float = Field(default=14, gt=0, le=365)
    # Katalog profili urządzeń (D44); w obrazie /app/profiles.
    profiles_dir: Path = Path("profiles")
    # Retencja (D49, O8). Minimum chroni przed skasowaniem danych literówką w .env.
    retention_raw_days: int = Field(default=90, ge=30, le=3650)
    retention_m5_days: int = Field(default=730, ge=90, le=3650)
    retention_runs_days: int = Field(default=90, ge=30, le=3650)
    # Alarmy zamknięte dawniej niż tyle dni są usuwane; otwarte nigdy (D55).
    retention_alarms_days: int = Field(default=365, ge=30, le=3650)
    partition_months_ahead: int = Field(default=12, ge=2, le=36)
    # Monitor serwera (D60): historia próbek metryk hosta [dni] (O11: 30).
    retention_system_days: int = Field(default=30, ge=1, le=365)
    # Adresy składników w sieci Compose; puste = składnik niemonitorowany (UNKNOWN).
    monitor_api_url: str | None = None
    monitor_proxy_address: str | None = None
    monitor_timeout_s: float = Field(default=2.0, gt=0, le=10)
    # Sprawdzanie aktualizacji (D63): wartość początkowa automatycznego sprawdzania
    # (instalator --no-update-check), adres podpisanego manifestu (podpis: adres + ".sig").
    update_check: bool = True
    update_manifest_url: str = Field(
        default="https://github.com/arkadiuszbaglaj/solargraf/releases/latest/download/manifest.json",
        pattern=r"^https://",
    )
    update_timeout_s: float = Field(default=15.0, gt=0, le=60)

    def database_url(self) -> URL:
        """URL dla SQLAlchemy (asyncpg). Hasło nie pojawia się w ``repr``/logach URL."""
        return URL.create(
            drivername="postgresql+asyncpg",
            username=self.db_user,
            password=self.db_password.get_secret_value(),
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        )
