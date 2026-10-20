"""
Validator Registry
==================

Central registry mapping command names to their validation functions.
"""

from .config_write_validators import validate_security_config_writes
from .database_validators import (
    validate_dropdb_command,
    validate_dropuser_command,
    validate_mongosh_command,
    validate_mysql_command,
    validate_mysqladmin_command,
    validate_psql_command,
    validate_redis_cli_command,
)
from .exec_validators import (
    validate_source_command,
    validate_tar_command,
)
from .filesystem_validators import (
    validate_chmod_command,
    validate_init_script,
    validate_rm_command,
)
from .git_validators import validate_git_commit
from .process_validators import (
    validate_kill_command,
    validate_killall_command,
    validate_pkill_command,
)
from .shell_validators import (
    validate_bash_command,
    validate_sh_command,
    validate_zsh_command,
)
from .validation_models import ValidatorFunction

# Map command names to their validation functions
VALIDATORS: dict[str, ValidatorFunction] = {
    # Process management
    "pkill": validate_pkill_command,
    "kill": validate_kill_command,
    "killall": validate_killall_command,
    # File system
    "chmod": validate_chmod_command,
    "rm": validate_rm_command,
    "init.sh": validate_init_script,
    # Git
    "git": validate_git_commit,
    # Shell interpreters (validate commands inside -c)
    "bash": validate_bash_command,
    "sh": validate_sh_command,
    "zsh": validate_zsh_command,
    # Commands that name a file whose contents would bypass the allowlist.
    # `eval` and `find -exec` name a command rather than a file, so they are
    # not here: `command_guard` recurses on what they name.
    "source": validate_source_command,
    ".": validate_source_command,
    "tar": validate_tar_command,
    # Database - PostgreSQL
    "dropdb": validate_dropdb_command,
    "dropuser": validate_dropuser_command,
    "psql": validate_psql_command,
    # Database - MySQL/MariaDB
    "mysql": validate_mysql_command,
    "mariadb": validate_mysql_command,  # Same syntax as mysql
    "mysqladmin": validate_mysqladmin_command,
    # Database - Redis
    "redis-cli": validate_redis_cli_command,
    # Database - MongoDB
    "mongosh": validate_mongosh_command,
    "mongo": validate_mongosh_command,  # Legacy mongo shell
}

#: Validators handed every command line, whatever command it runs. A
#: redirection writes through a command (`echo x >> file`) that has no entry
#: above, so a rule about *what is written* cannot be keyed on a command name.
#: `command_guard.validate_command_line` runs these at every level it recurses
#: into: `$(…)`, backticks, `eval`, `find -exec`.
LINE_VALIDATORS: tuple[ValidatorFunction, ...] = (
    # The project's security configuration: the allowlist, the security
    # profile, the guardrails and the SDK settings. `path_guard` refuses the
    # same files to the write tools.
    validate_security_config_writes,
)


def get_validator(command_name: str) -> ValidatorFunction | None:
    """
    Get the validator function for a given command name.

    Args:
        command_name: The name of the command to validate

    Returns:
        The validator function, or None if no validator exists
    """
    return VALIDATORS.get(command_name)
