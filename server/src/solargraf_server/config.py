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
