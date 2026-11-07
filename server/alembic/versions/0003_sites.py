"""Instalacje i zawężenie członkostwa do instalacji (P2.2, D33).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Istniejące członkostwa zachowują dotychczasowy (pełny) zakres dostępu.
    op.add_column(
        "memberships",
        sa.Column("all_sites", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("memberships", "all_sites", server_default=None)
    op.create_table(
        "sites",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_sites_organization_id_organizations",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sites"),
    )
    op.create_index("ix_sites_organization_id", "sites", ["organization_id"])
    op.create_table(
        "membership_sites",
        sa.Column("membership_id", sa.Uuid(), nullable=False),
        sa.Column("site_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["membership_id"],
            ["memberships.id"],
            name="fk_membership_sites_membership_id_memberships",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["site_id"], ["sites.id"], name="fk_membership_sites_site_id_sites", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("membership_id", "site_id", name="pk_membership_sites"),
    )
    op.create_index("ix_membership_sites_site_id", "membership_sites", ["site_id"])


def downgrade() -> None:
    op.drop_index("ix_membership_sites_site_id", table_name="membership_sites")
    op.drop_table("membership_sites")
    op.drop_index("ix_sites_organization_id", table_name="sites")
    op.drop_table("sites")
    op.drop_column("memberships", "all_sites")
