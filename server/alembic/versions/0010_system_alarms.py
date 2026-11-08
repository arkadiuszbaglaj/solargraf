"""Alarmy systemowe (P7.1d, D68): historia przyczyn oceny monitora serwera.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-08

Migracja tylko dodaje tabelę — istniejące dane pozostają bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "system_alarms",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(48), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("message", sa.String(300), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_by", sa.Uuid(), nullable=True),
        sa.CheckConstraint("severity IN ('WARNING', 'CRITICAL')", name="ck_system_alarms_severity"),
        sa.CheckConstraint(
            "closed_at IS NULL OR closed_at >= opened_at",
            name="ck_system_alarms_closed_after_opened",
        ),
        sa.ForeignKeyConstraint(
            ["acknowledged_by"],
            ["users.id"],
            name="fk_system_alarms_acknowledged_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_system_alarms"),
    )
    op.create_index("ix_system_alarms_closed_at", "system_alarms", ["closed_at"])
    op.create_index(
        "uq_system_alarms_open_code",
        "system_alarms",
        ["code"],
        unique=True,
        postgresql_where=sa.text("closed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("system_alarms")
