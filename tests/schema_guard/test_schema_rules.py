"""What the schema guard reads in a migration, tool by tool (#386).

Each case is the ``up`` of a real-looking migration of one tool: what a
running deploy would not survive is an error, a lock or a missing rollback a
warning, and what the migration itself created (a table, then its index) is
never flagged. The ``down`` part is not read for findings: its ``DROP`` is
the rollback of a ``CREATE``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from schema_guard import analyse, detect_engine, migration_tool
from schema_guard.rules import (
    DATA_LOSS,
    LOCK,
    NO_ROLLBACK,
    NOT_NULL,
    RENAME,
    TYPE_CHANGE,
)


def _kinds(path: str, text: str, tool: str, engine: str = "postgres"):
    return sorted(
        (f.kind, f.severity, f.line) for f in analyse(path, text, tool, engine)
    )


EF = """
public partial class AddEmail : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(
            name: "EmailVerified", table: "Users", type: "boolean", nullable: false);
        migrationBuilder.DropColumn(name: "Legacy", table: "Users");
        migrationBuilder.CreateTable(name: "Orders", columns: table => new { });
        migrationBuilder.CreateIndex(name: "IX_Orders_Id", table: "Orders", column: "Id");
        migrationBuilder.CreateIndex(name: "IX_Users_Email", table: "Users", column: "Email");
        migrationBuilder.Sql(@"ALTER TABLE ""Users"" RENAME COLUMN ""Name"" TO ""FullName"";");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "Orders");
    }
}
"""


def test_ef_core_names_the_column_the_old_code_breaks_on():
    assert _kinds("Data/Migrations/20261109_AddEmail.cs", EF, "efcore") == [
        (DATA_LOSS, "error", 8),
        (LOCK, "warning", 11),
        (NOT_NULL, "error", 6),
        (RENAME, "error", 12),
    ]
    # The DropTable of Down is the rollback, never a finding.
    assert all(f.line < 14 for f in analyse("m.cs", EF, "efcore", "postgres"))


def test_locks_are_postgresql_s_only():
    kinds = {k for k, _, _ in _kinds("m.cs", EF, "efcore", engine="sqlserver")}
    assert LOCK not in kinds and NOT_NULL in kinds


DJANGO = """
from django.db import migrations, models

class Migration(migrations.Migration):
    operations = [
        migrations.CreateModel(name="Order", fields=[("id", models.AutoField())]),
        migrations.AddField(model_name="order", name="total", field=models.IntegerField()),
        migrations.AddField(model_name="user", name="age", field=models.IntegerField()),
        migrations.AddField(model_name="user", name="bio", field=models.TextField(null=True)),
        migrations.AddIndex(model_name="user", index=models.Index(fields=["age"], name="i")),
        migrations.RemoveField(model_name="user", name="legacy"),
        migrations.RunPython(forwards),
        migrations.RunPython(forwards, backwards),
    ]
"""


def test_django_reads_its_operations():
    assert _kinds("shop/migrations/0002_age.py", DJANGO, "django") == [
        (DATA_LOSS, "error", 11),
        (LOCK, "warning", 10),
        (NO_ROLLBACK, "warning", 12),
        (NOT_NULL, "error", 8),
    ]


ALEMBIC = """
def upgrade():
    op.add_column("users", sa.Column("role", sa.String(), nullable=False))
    op.add_column("users", sa.Column("kind", sa.String(), nullable=False, server_default="a"))
    op.create_index("ix_role", "users", ["role"])
    op.create_index("ix_kind", "users", ["kind"], postgresql_concurrently=True)
    op.alter_column("users", "name", new_column_name="full_name")
    op.execute("DROP TABLE legacy")


def downgrade():
    pass
"""


def test_alembic_reads_its_ops_and_the_sql_it_executes():
    assert _kinds("alembic/versions/ab12_role.py", ALEMBIC, "alembic") == [
        (DATA_LOSS, "error", 8),
        (LOCK, "warning", 5),
        (NO_ROLLBACK, "warning", 2),
        (NOT_NULL, "error", 3),
        (RENAME, "error", 7),
    ]


RAILS = """
class AddRole < ActiveRecord::Migration[7.1]
  disable_ddl_transaction!

  def change
    add_column :users, :role, :string, null: false
    add_column :users, :kind, :string, null: false, default: "a"
    add_index :users, :role
    add_index :users, :kind, algorithm: :concurrently
    create_table :posts do |t|
      t.string :title, null: false
    end
    add_index :posts, :title
    remove_column :users, :legacy, :string
  end
end
"""


def test_rails_change_is_reversible_and_its_new_table_is_not_locked():
    assert _kinds("db/migrate/20261109_add_role.rb", RAILS, "rails") == [
        (DATA_LOSS, "error", 14),
        (LOCK, "warning", 8),
        (NOT_NULL, "error", 6),
    ]


LARAVEL = """<?php
return new class extends Migration {
    public function up(): void
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->index('title');
        });
        Schema::table('users', function (Blueprint $table) {
            $table->string('role');
            $table->string('bio')->nullable();
            $table->index('role');
        });
    }

    public function down(): void
    {
    }
};
"""


def test_laravel_knows_which_schema_block_creates_its_table():
    assert _kinds(
        "database/migrations/2026_11_09_add_role.php", LARAVEL, "laravel"
    ) == [
        (LOCK, "warning", 13),
        (NO_ROLLBACK, "warning", 3),
        (NOT_NULL, "error", 11),
    ]


KNEX = """
exports.up = function (knex) {
  return knex.schema
    .alterTable('users', (t) => {
      t.string('role').notNullable();
      t.string('kind').notNullable().defaultTo('a');
    })
    .createTable('posts', (t) => {
      t.string('title').notNullable();
    });
};

exports.down = (knex) => knex.schema.dropTable('posts');
"""

SEQUELIZE = """
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'role', { type: Sequelize.STRING, allowNull: false });
    await queryInterface.addIndex('users', ['role']);
    await queryInterface.renameColumn('users', 'name', 'fullName');
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'role');
  },
};
"""

TYPEORM = """
export class AddRole1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "role" character varying NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_role" ON "users" ("role")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {}
}
"""


@pytest.mark.parametrize(
    ("path", "text", "tool", "expected"),
    [
        ("migrations/20261109_role.js", KNEX, "knex", [(NOT_NULL, "error", 5)]),
        (
            "migrations/20261109-role.js",
            SEQUELIZE,
            "sequelize",
            [(LOCK, "warning", 5), (NOT_NULL, "error", 4), (RENAME, "error", 6)],
        ),
        (
            "src/migrations/1700000000000-AddRole.ts",
            TYPEORM,
            "typeorm",
            [(LOCK, "warning", 5), (NO_ROLLBACK, "warning", 3), (NOT_NULL, "error", 4)],
        ),
    ],
)
def test_node_migrations(path, text, tool, expected):
    assert _kinds(path, text, tool) == expected


ECTO = """
defmodule Shop.Repo.Migrations.AddRole do
  use Ecto.Migration

  def change do
    alter table(:users) do
      add :role, :string, null: false
      add :kind, :string, null: false, default: "a"
      remove :legacy
    end
    create index(:users, [:role])
    create index(:users, [:kind], concurrently: true)
  end
end
"""


def test_ecto():
    assert _kinds("priv/repo/migrations/20261109_add_role.exs", ECTO, "ecto") == [
        (DATA_LOSS, "error", 9),
        (LOCK, "warning", 11),
        (NOT_NULL, "error", 7),
    ]


PRISMA = """-- CreateTable
CREATE TABLE "Post" ("id" SERIAL NOT NULL, "title" TEXT NOT NULL);
CREATE INDEX "Post_title_idx" ON "Post"("title");
ALTER TABLE "Post" ADD CONSTRAINT "fk" FOREIGN KEY ("u") REFERENCES "User"("id");
-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL;
ALTER TABLE "User" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'a';
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX CONCURRENTLY "User_kind_idx" ON "User"("kind");
ALTER TABLE "User" DROP COLUMN "legacy";
ALTER TABLE "User" DROP CONSTRAINT "x";
ALTER TABLE "User" ALTER COLUMN "age" SET DATA TYPE BIGINT;
ALTER TABLE "User" ALTER COLUMN "age" SET NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "fk2" FOREIGN KEY ("org") REFERENCES "Org"("id");
ALTER TABLE "User" ADD CONSTRAINT "fk3" FOREIGN KEY ("t") REFERENCES "T"("id") NOT VALID;
ALTER TABLE "User" RENAME CONSTRAINT "a" TO "b";
"""


def test_sql_migrations_are_read_statement_by_statement():
    assert _kinds(
        "prisma/migrations/20261109_role/migration.sql", PRISMA, "prisma"
    ) == [
        (DATA_LOSS, "error", 10),
        (LOCK, "warning", 8),
        (LOCK, "warning", 14),
        (NOT_NULL, "error", 6),
        (NOT_NULL, "warning", 13),
        (TYPE_CHANGE, "warning", 12),
    ]


def test_mysql_and_sql_server_renames_and_type_changes():
    sql = (
        "ALTER TABLE users CHANGE COLUMN name full_name VARCHAR(80);\n"
        "ALTER TABLE users MODIFY COLUMN age BIGINT;\n"
        "EXEC sp_rename 'users.name', 'full_name', 'COLUMN';\n"
        "ALTER TABLE users ALTER COLUMN age BIGINT NOT NULL;\n"
        "TRUNCATE TABLE sessions;\n"
    )
    kinds = _kinds("db/migration/V2__role.sql", sql, "flyway", engine="mysql")
    assert [k for k, _, _ in kinds] == [
        DATA_LOSS,
        RENAME,
        RENAME,
        TYPE_CHANGE,
        TYPE_CHANGE,
    ]


def test_the_advice_is_the_tool_s_own_way():
    advice = {
        f.kind: f.advice
        for f in analyse("db/migrate/1_x.rb", RAILS, "rails", "postgres")
    }
    assert "algorithm: :concurrently" in advice[LOCK]
    assert "backfill" in advice[NOT_NULL]
    django = {
        f.kind: f.advice
        for f in analyse("a/migrations/0001_x.py", DJANGO, "django", "postgres")
    }
    assert "AddIndexConcurrently" in django[LOCK]


@pytest.mark.parametrize(
    ("path", "text", "tool"),
    [
        ("src/Data/Migrations/20261109_Init.cs", "class Init : Migration {}", "efcore"),
        ("shop/migrations/0001_initial.py", "", "django"),
        ("alembic/versions/ab12_x.py", "def upgrade():\n    pass", "alembic"),
        ("db/migrate/20261109_x.rb", "", "rails"),
        ("database/migrations/2026_x.php", "", "laravel"),
        (
            "migrations/Version20261109.php",
            "$this->addSql('ALTER TABLE x');",
            "doctrine",
        ),
        ("priv/repo/migrations/1_x.exs", "", "ecto"),
        ("migrations/1_x.ts", "async up(queryRunner) {} async down() {}", "typeorm"),
        ("migrations/1_x.js", "exports.up = (knex) => knex.schema.table('x')", "knex"),
        ("migrations/1_x.js", "up: async (queryInterface) => {}", "sequelize"),
        ("prisma/migrations/1_x/migration.sql", "", "prisma"),
        ("supabase/migrations/1_x.sql", "", "supabase"),
        ("migrations/2026-11-09_x/up.sql", "", "diesel"),
        ("db/migrations/000001_x.up.sql", "", "golang-migrate"),
        ("src/main/resources/db/migration/V1_2__x.sql", "", "flyway"),
        ("drizzle/0001_x.sql", "", "drizzle"),
        ("db/migrations/2026_x.sql", "", "sql"),
    ],
)
def test_every_tool_is_recognised_by_its_path(path, text, tool):
    assert migration_tool(path, lambda _: text) == tool


@pytest.mark.parametrize(
    "path",
    [
        "src/Data/Migrations/20261109_Init.Designer.cs",
        "src/Data/Migrations/AppDbContextModelSnapshot.cs",
        "db/migrations/000001_x.down.sql",
        "migrations/2026-11-09_x/down.sql",
        "src/main/resources/db/migration/U2__undo.sql",
        "shop/migrations/__init__.py",
        "src/services/user.ts",
        "migrations/README.md",
    ],
)
def test_what_is_not_a_migration(path):
    assert migration_tool(path, lambda _: "class X : Migration { up down }") is None


@pytest.mark.parametrize(
    ("files", "engine"),
    [
        (
            {
                "Api/Api.csproj": '<PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" />'
            },
            "postgres",
        ),
        ({"prisma/schema.prisma": 'datasource db {\n  provider = "mysql"\n}'}, "mysql"),
        ({"config/database.yml": "production:\n  adapter: sqlserver"}, "sqlserver"),
        (
            {"package.json": '{"dependencies": {"pg": "8", "better-sqlite3": "9"}}'},
            "postgres",
        ),
        ({"go.mod": "require github.com/jackc/pgx/v5 v5.5.0"}, "postgres"),
        ({"pyproject.toml": "dependencies = ['psycopg2', 'pymysql']"}, "unknown"),
        ({}, "unknown"),
    ],
)
def test_the_engine_comes_from_the_manifests(tmp_path: Path, files, engine):
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text, encoding="utf-8")
    assert detect_engine(tmp_path) == engine
