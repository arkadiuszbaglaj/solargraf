"""Alarm „Niepełne odczyty” (D76): nowy kod w ograniczeniu ``ck_alarms_code``.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-09

Migracja tylko rozszerza listę dozwolonych kodów — istniejące wiersze pozostają bez zmian.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "code IN ('AGENT_UNREACHABLE', 'DEVICE_READ_ERROR', 'DEVICE_STALE')"
NEW = "code IN ('AGENT_UNREACHABLE', 'DEVICE_READ_ERROR', 'DEVICE_STALE', 'DEVICE_PARTIAL_READ')"


def upgrade() -> None:
    op.drop_constraint("ck_alarms_code", "alarms", type_="check")
    op.create_check_constraint("ck_alarms_code", "alarms", NEW)


def downgrade() -> None:
    # Cofnięcie usuwa alarmy nowego kodu — inaczej stare ograniczenie by ich nie przyjęło.
    op.execute("DELETE FROM alarms WHERE code = 'DEVICE_PARTIAL_READ'")
    op.drop_constraint("ck_alarms_code", "alarms", type_="check")
    op.create_check_constraint("ck_alarms_code", "alarms", OLD)
