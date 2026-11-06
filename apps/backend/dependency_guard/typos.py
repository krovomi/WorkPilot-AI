"""A name one keystroke away from a well-known package: a warning, never a block.

`reqeusts` exists on PyPI because someone hoped for exactly this typo. The
list below is short on purpose (the most installed packages of each registry,
where a typo is most likely and most profitable); a miss costs nothing but a
warning not shown, a hit costs a reviewer one look.
"""

from __future__ import annotations

__all__ = ["near_miss"]

_POPULAR: dict[str, frozenset[str]] = {
    "npm": frozenset(
        """react react-dom lodash express axios typescript vue next nuxt angular
        @angular/core rxjs zod moment dayjs chalk commander debug dotenv uuid
        webpack vite eslint prettier jest vitest mocha jquery redux tailwindcss
        mongoose prisma sequelize socket.io cors body-parser jsonwebtoken bcrypt
        nodemon yargs inquirer glob minimist semver request""".split()
    ),
    "pypi": frozenset(
        """requests numpy pandas django flask fastapi pydantic sqlalchemy pytest
        boto3 botocore urllib3 setuptools six python-dateutil pyyaml certifi
        idna charset-normalizer click jinja2 scipy matplotlib pillow httpx
        aiohttp celery redis psycopg2 cryptography attrs packaging uvicorn
        selenium beautifulsoup4 tensorflow torch scikit-learn openai anthropic""".split()
    ),
    "nuget": frozenset(
        """newtonsoft.json serilog automapper mediatr dapper polly fluentvalidation
        xunit nunit moq fluentassertions swashbuckle.aspnetcore
        microsoft.entityframeworkcore microsoft.extensions.logging
        microsoft.extensions.dependencyinjection system.text.json
        stackexchange.redis npgsql bogus nsubstitute hangfire""".split()
    ),
    "cargo": frozenset(
        """serde serde_json tokio rand clap regex anyhow thiserror reqwest log
        chrono itertools lazy_static once_cell futures hyper axum tracing""".split()
    ),
    "packagist": frozenset(
        """laravel/framework symfony/console guzzlehttp/guzzle monolog/monolog
        phpunit/phpunit doctrine/orm nesbot/carbon vlucas/phpdotenv""".split()
    ),
    "rubygems": frozenset(
        """rails rake rspec bundler nokogiri devise puma sidekiq pg rack""".split()
    ),
    "pub": frozenset(
        """http provider flutter_bloc get dio shared_preferences intl
        path_provider equatable riverpod""".split()
    ),
}


def _distance_at_most_one(a: str, b: str) -> bool:
    """One insertion, deletion, substitution or swap of neighbours apart."""
    if a == b:
        return False
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        diffs = [i for i in range(la) if a[i] != b[i]]
        if len(diffs) == 1:
            return True
        return (
            len(diffs) == 2
            and diffs[1] == diffs[0] + 1
            and a[diffs[0]] == b[diffs[1]]
            and a[diffs[1]] == b[diffs[0]]
        )
    short, long_ = (a, b) if la < lb else (b, a)
    i = 0
    while i < len(short) and short[i] == long_[i]:
        i += 1
    return short[i:] == long_[i + 1 :]


def near_miss(ecosystem: str, name: str) -> str | None:
    """The popular package ``name`` is one keystroke from, if any."""
    popular = _POPULAR.get(ecosystem)
    if not popular:
        return None
    folded = name.lower()
    if folded in popular or len(folded) < 4:
        return None
    for known in sorted(popular):
        if _distance_at_most_one(folded, known):
            return known
    return None
