import pytest
from pydantic import ValidationError

from solargraf_server.authz import SiteAction, role_allows
from solargraf_server.models import Role
from solargraf_server.sites import SiteCreate, validate_timezone

ORG = "00000000-0000-0000-0000-000000000001"


@pytest.mark.parametrize(
    ("role", "action", "allowed"),
    [
        (Role.OWNER, SiteAction.READ, True),
        (Role.OWNER, SiteAction.MANAGE, True),
        (Role.ADMIN, SiteAction.READ, True),
        (Role.ADMIN, SiteAction.MANAGE, True),
        (Role.VIEWER, SiteAction.READ, True),
        (Role.VIEWER, SiteAction.MANAGE, False),
    ],
)
def test_role_matrix_d29(role: Role, action: SiteAction, allowed: bool) -> None:
    assert role_allows(role, action) is allowed


@pytest.mark.parametrize("tz", ["Europe/Warsaw", "America/New_York", "UTC"])
def test_valid_timezones(tz: str) -> None:
    assert validate_timezone(tz) == tz


@pytest.mark.parametrize(
    "tz", ["Mars/Olympus", "CET", "Europe/../../etc/passwd", "/etc/localtime", "", "warsaw"]
)
def test_invalid_timezones(tz: str) -> None:
    with pytest.raises(ValueError, match="strefa"):
        validate_timezone(tz)


def test_site_create_defaults_to_warsaw_and_strips_name() -> None:
    body = SiteCreate(organization_id=ORG, name="  Dom  ")  # type: ignore[arg-type]
    assert body.timezone == "Europe/Warsaw"
    assert body.name == "Dom"


def test_site_create_rejects_blank_name() -> None:
    with pytest.raises(ValidationError):
        SiteCreate(organization_id=ORG, name="   ")  # type: ignore[arg-type]
