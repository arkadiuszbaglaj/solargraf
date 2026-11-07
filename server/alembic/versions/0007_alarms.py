"""Alarmy instalacji (P5.5, D55).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-07

Migracja tylko dodaje tabelę — istniejące dane pozostają bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "alarms",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=True),
        sa.Column("agent_id", sa.Uuid(), nullable=True),
        sa.Column("subject", sa.String(64), nullable=False),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("details", sa.String(500), nullable=True),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rule_version", sa.SmallInteger(), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("clear_count", sa.Integer(), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_by", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "severity IN ('CRITICAL', 'WARNING', 'INFO')", name="ck_alarms_severity"
        ),
        sa.CheckConstraint(
            "code IN ('AGENT_UNREACHABLE', 'DEVICE_READ_ERROR', 'DEVICE_STALE')",
            name="ck_alarms_code",
        ),
        sa.CheckConstraint("clear_count >= 0", name="ck_alarms_clear_count"),
        sa.CheckConstraint(
            "closed_at IS NULL OR closed_at >= opened_at", name="ck_alarms_closed_after_opened"
        ),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_alarms_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["device_id"], ["devices.id"], name="fk_alarms_device_id_devices", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"], ["agents.id"], name="fk_alarms_agent_id_agents", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["acknowledged_by"],
            ["users.id"],
            name="fk_alarms_acknowledged_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_alarms"),
    )
    op.create_index("ix_alarms_site_id", "alarms", ["site_id"])
    op.create_index("ix_alarms_device_id", "alarms", ["device_id"])
    op.create_index("ix_alarms_agent_id", "alarms", ["agent_id"])
    op.create_index("ix_alarms_closed_at", "alarms", ["closed_at"])
    op.create_index(
        "uq_alarms_open_subject",
        "alarms",
        ["site_id", "code", "subject"],
        unique=True,
        postgresql_where=sa.text("closed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("alarms")
