import pytest
from pydantic import SecretStr, ValidationError

from solargraf_server.config import Settings


def test_password_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SOLARGRAF_DB_PASSWORD", raising=False)
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_reads_prefixed_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOLARGRAF_DB_PASSWORD", "from-env")
    monkeypatch.setenv("SOLARGRAF_DB_HOST", "db")
    settings = Settings()  # type: ignore[call-arg]
    assert settings.db_host == "db"
    assert settings.db_password.get_secret_value() == "from-env"


def test_password_not_exposed_in_repr_or_url_string() -> None:
    settings = Settings(db_password=SecretStr("s3cret-value"))
    assert "s3cret-value" not in repr(settings)
    assert "s3cret-value" not in str(settings.database_url())
    assert settings.database_url().drivername == "postgresql+asyncpg"


@pytest.mark.parametrize("port", [0, 70000])
def test_rejects_invalid_port(port: int) -> None:
    with pytest.raises(ValidationError):
        Settings(db_password=SecretStr("x"), db_port=port)
