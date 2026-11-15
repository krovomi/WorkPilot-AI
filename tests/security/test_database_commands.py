"""Each database command validator: what it refuses, and what it lets through.

A refusal is proven with the command an agent would type; so is the
command that must still run.
"""

from __future__ import annotations

import pytest
from security.database_validators import (
    _contains_destructive_sql,
    validate_dropdb_command,
    validate_dropuser_command,
    validate_mongosh_command,
    validate_mysql_command,
    validate_mysqladmin_command,
    validate_psql_command,
    validate_redis_cli_command,
)

VALIDATORS = [
    validate_dropdb_command,
    validate_dropuser_command,
    validate_psql_command,
    validate_mysql_command,
    validate_mysqladmin_command,
    validate_redis_cli_command,
    validate_mongosh_command,
]


@pytest.mark.parametrize("validator", VALIDATORS)
def test_unparsable_and_empty_commands_are_refused(validator):
    assert validator('cmd "unclosed')[0] is False
    assert validator("")[0] is False


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM public.users;",
        'DELETE FROM "Users"',
        "DELETE FROM `users`;",
        "DELETE FROM [dbo].[users]",
        "TRUNCATE public.audit",
        "DELETE FROM app.users WHERE 1 = 1",
    ],
)
def test_qualified_and_quoted_tables_are_still_tables(sql):
    assert _contains_destructive_sql(sql)[0] is True, sql


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("dropdb -w test_orders", True),
        ("dropdb --no-password --if-exists dev_db", True),
        ("dropdb -W -U admin production", False),
        ("dropdb --maintenance-db postgres test_db", True),
        ("dropdb -h localhost", False),
    ],
)
def test_dropdb_flags_without_a_value_do_not_hide_the_name(command, allowed):
    assert validate_dropdb_command(command)[0] is allowed


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("dropuser test_reader", True),
        ("dropuser -w ci_dev", True),
        ("dropuser -h db -U admin MOCK_user", True),
        ("dropuser -W admin", False),
        ("dropuser -p 5432", False),
    ],
)
def test_dropuser_only_drops_test_users(command, allowed):
    ok, message = validate_dropuser_command(command)
    assert ok is allowed
    if not allowed:
        assert "dropuser" in message


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ('psql -c "SELECT 1" -c "DROP DATABASE prod"', False),
        ('psql --command "SELECT 1" -c "TRUNCATE users"', False),
        ('psql --command="DELETE FROM public.users"', False),
        ('psql -c"DROP TABLE t"', False),
        ("psql --file=seed.sql", False),
        ('psql -c "SELECT 1" -c "SELECT 2"', True),
        ("psql -l", True),
    ],
)
def test_psql_scans_every_command(command, allowed):
    assert validate_psql_command(command)[0] is allowed


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ('mysql -e "DROP DATABASE prod"', False),
        ('mysql --execute="DROP DATABASE prod"', False),
        ('mysql --execute "TRUNCATE orders"', False),
        ('mysql -e"DELETE FROM shop.orders"', False),
        ('mysql -e "SELECT 1" -e "DROP TABLE t"', False),
        ('mysql -e "SELECT 1" shop', True),
        ("mysql shop", True),
    ],
)
def test_mysql_scans_every_form_of_execute(command, allowed):
    ok, message = validate_mysql_command(command)
    assert ok is allowed, command
    if not allowed:
        assert "destructive SQL" in message


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("mysqladmin drop shop", False),
        ("mysqladmin -u root SHUTDOWN", False),
        ("mysqladmin status", True),
    ],
)
def test_mysqladmin(command, allowed):
    assert validate_mysqladmin_command(command)[0] is allowed


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ("redis-cli FLUSHALL", False),
        ("redis-cli -h cache -a pw flushdb", False),
        ("redis-cli -r 1 FLUSHALL", False),
        ("redis-cli -i 0.1 -r 3 CONFIG SET dir /tmp", False),
        ("redis-cli -s /tmp/redis.sock --tls --cacert ca.pem SHUTDOWN", False),
        ("redis-cli --eval purge.lua", False),
        ("redis-cli --pipe", False),
        ("redis-cli --cluster reshard 127.0.0.1:7000", False),
        ("redis-cli -n 2 GET FLUSHALL", True),
        ("redis-cli --raw -r 2 PING", True),
        ("redis-cli --scan --pattern 'user:*'", True),
        ("redis-cli -h cache", True),
    ],
)
def test_redis_cli_finds_the_command_past_every_option(command, allowed):
    assert validate_redis_cli_command(command)[0] is allowed, command


@pytest.mark.parametrize(
    ("command", "allowed"),
    [
        ('mongosh shop --eval "db.dropDatabase()"', False),
        ("mongosh --eval=db.orders.drop()", False),
        ('mongosh --eval "db.x.find()" --eval "db.x.deleteMany({})"', False),
        ('mongosh --eval "db.orders.find()"', True),
        ("mongosh shop", True),
    ],
)
def test_mongosh_scans_every_eval(command, allowed):
    assert validate_mongosh_command(command)[0] is allowed, command
