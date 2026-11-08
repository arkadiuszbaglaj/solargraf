"""Sprawdzanie aktualizacji (P7.3a, D63): stan i ostatni zweryfikowany manifest.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-08

Migracja tylko dodaje tabelę — istniejące dane pozostają bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ERRORS = "'NOT_CONFIGURED', 'NETWORK', 'TOO_LARGE', 'INVALID_SIGNATURE', 'INVALID_MANIFEST'"


def upgrade() -> None:
    op.create_table(
        "update_status",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("automatic", sa.Boolean(), nullable=False),
        sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(32), nullable=True),
        sa.Column("manifest", postgresql.JSONB(), nullable=True),
        sa.Column("dismissed_version", sa.String(32), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_update_status_single_row"),
        sa.CheckConstraint(
            f"last_error IS NULL OR last_error IN ({ERRORS})", name="ck_update_status_last_error"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_update_status"),
    )


def downgrade() -> None:
    op.drop_table("update_status")
