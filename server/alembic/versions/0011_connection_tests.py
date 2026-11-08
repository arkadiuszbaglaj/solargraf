"""Test komunikacji przed dodaniem urządzenia (D72): zlecenia dla agenta i wyniki.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-08

Migracja tylko dodaje tabelę — istniejące dane pozostają bez zmian.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ERRORS = (
    "'TIMEOUT', 'CONNECTION_REFUSED', 'CONNECTION_LOST', 'MODBUS_EXCEPTION', "
    "'INVALID_RESPONSE', 'UNKNOWN_PROFILE', 'TARGET_IN_USE'"
)


def upgrade() -> None:
    op.create_table(
        "connection_tests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=False),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("host", sa.String(253), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("unit_id", sa.Integer(), nullable=False),
        sa.Column("profile_id", sa.String(100), nullable=False),
        sa.Column("profile_version", sa.String(32), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result", sa.String(16), nullable=True),
        sa.Column("error_code", sa.String(32), nullable=True),
        sa.Column("origin", sa.String(16), nullable=True),
        sa.Column("readings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.CheckConstraint(
            "state IN ('PENDING', 'RUNNING', 'DONE')", name="ck_connection_tests_state"
        ),
        sa.CheckConstraint(
            "result IS NULL OR result IN ('OK', 'PARTIAL', 'FAILED')",
            name="ck_connection_tests_result",
        ),
        sa.CheckConstraint(
            f"error_code IS NULL OR error_code IN ({ERRORS})", name="ck_connection_tests_error_code"
        ),
        sa.CheckConstraint(
            "origin IS NULL OR origin IN ('DEVICE', 'SIMULATED')", name="ck_connection_tests_origin"
        ),
        sa.CheckConstraint("port BETWEEN 1 AND 65535", name="ck_connection_tests_port"),
        sa.CheckConstraint("unit_id BETWEEN 0 AND 255", name="ck_connection_tests_unit_id"),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_connection_tests_site_id_sites", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"],
            ["agents.id"],
            name="fk_connection_tests_agent_id_agents",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
            name="fk_connection_tests_requested_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_connection_tests"),
    )
    op.create_index("ix_connection_tests_site_id", "connection_tests", ["site_id"])
    op.create_index("ix_connection_tests_agent_id_state", "connection_tests", ["agent_id", "state"])


def downgrade() -> None:
    op.drop_table("connection_tests")
