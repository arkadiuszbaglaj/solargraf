"""Szybki odczyt do podglądu na żywo (D78): ``connections.live_interval_seconds``.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-09

Kolumna opcjonalna — puste znaczy „z profilu”; istniejące połączenia bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("connections", sa.Column("live_interval_seconds", sa.Double(), nullable=True))
    op.create_check_constraint(
        "ck_connections_live_interval",
        "connections",
        "live_interval_seconds IS NULL OR live_interval_seconds >= 1",
    )


def downgrade() -> None:
    op.drop_constraint("ck_connections_live_interval", "connections", type_="check")
    op.drop_column("connections", "live_interval_seconds")
