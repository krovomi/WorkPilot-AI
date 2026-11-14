"""Domain-Specific Agent Factory.

Catalogue of `DomainProfile`s — each profile knows the guardrails,
required skills, and validation rules a given industry expects.

The factory composes a profile + an agent role (coder / planner / reviewer)
into a `DomainAgentBundle` ready to be injected into the existing agents.

This is intentionally **declarative**: profiles are data, no LLM calls,
no I/O. Adding a new domain = appending one entry to the catalogue.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class DomainTag(str, Enum):
    GENERIC = "generic"
    ECOMMERCE = "ecommerce"
    FINTECH = "fintech"
    HEALTHCARE = "healthcare"
    GAMING = "gaming"
    IOT = "iot"
    GOVTECH = "govtech"
    EDUCATION = "education"
    SAAS = "saas"
    DATA_PIPELINE = "data_pipeline"


class AgentRole(str, Enum):
    CODER = "coder"
    PLANNER = "planner"
    REVIEWER = "reviewer"
    DOCUMENTER = "documenter"


@dataclass(frozen=True)
class DomainProfile:
    """All the domain-specific knowledge in one place."""

    tag: DomainTag
    label: str
    description: str
    guardrails: tuple[str, ...]
    required_skills: tuple[str, ...]
    forbidden_patterns: tuple[str, ...]
    validation_rules: tuple[str, ...]
    # Per stack, keyed by `project.stack.detect_languages` names ("python",
    # "c#", "javascript/typescript", "java/kotlin", "go", "rust", "php",
    # "ruby", "dart", "swift"): a .NET project is never told to use a PyPI
    # package. A stack absent here simply gets no library advice.
    suggested_libraries: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    def libraries_for(self, languages: list[str] | None) -> dict[str, list[str]]:
        """The suggestions for ``languages``; every stack's when it is None."""
        wanted = self.suggested_libraries.keys() if languages is None else languages
        return {
            lang: list(self.suggested_libraries[lang])
            for lang in wanted
            if self.suggested_libraries.get(lang)
        }

    def to_dict(self) -> dict:
        return {
            "tag": self.tag.value,
            "label": self.label,
            "description": self.description,
            "guardrails": list(self.guardrails),
            "required_skills": list(self.required_skills),
            "forbidden_patterns": list(self.forbidden_patterns),
            "validation_rules": list(self.validation_rules),
            "suggested_libraries": self.libraries_for(None),
        }


# ----------------------------------------------------------------------
# Catalogue


_GENERIC = DomainProfile(
    tag=DomainTag.GENERIC,
    label="Generic",
    description="No domain assumptions — neutral defaults.",
    guardrails=(
        "Follow the project's existing conventions and style.",
        "Add tests for new behaviour.",
    ),
    required_skills=(),
    forbidden_patterns=(),
    validation_rules=("All tests pass", "Linter is clean"),
)

_ECOMMERCE = DomainProfile(
    tag=DomainTag.ECOMMERCE,
    label="E-commerce",
    description="Storefront, cart, checkout, inventory, payment.",
    guardrails=(
        "Cart and inventory mutations must be idempotent — assume retries.",
        "Never store card numbers in your domain DB; tokenise via the payment gateway.",
        "Inventory decrement must be atomic with order creation (use a transaction).",
        "Currency math must never use floats — use integer minor units (cents).",
    ),
    required_skills=("idempotency-keys", "payment-tokenisation", "inventory-locks"),
    forbidden_patterns=(
        r"price\s*=\s*\d+\.\d+",  # float prices
        r"raw_card_number",
        r"\.charge\(.*card_number",
    ),
    validation_rules=(
        "Cart endpoints accept and respect Idempotency-Key headers",
        "All money fields are integer cents, never float",
        "Order + inventory are committed in a single transaction",
        "Payment events go through the gateway SDK, not raw HTTP",
    ),
    suggested_libraries={
        "python": ("stripe", "py-moneyed"),
        "c#": ("Stripe.net", "NodaMoney"),
        "javascript/typescript": ("stripe", "dinero.js"),
        "java/kotlin": ("com.stripe:stripe-java", "org.javamoney:moneta"),
        "go": ("github.com/stripe/stripe-go", "github.com/Rhymond/go-money"),
        "php": ("stripe/stripe-php", "moneyphp/money"),
        "ruby": ("stripe", "money"),
        "rust": ("async-stripe", "rusty-money"),
        "dart": ("flutter_stripe",),
    },
)

_FINTECH = DomainProfile(
    tag=DomainTag.FINTECH,
    label="Fintech",
    description="Payments, ledgers, transfers, regulated workflows.",
    guardrails=(
        "Every money-moving operation must produce a double-entry ledger record.",
        "All operations must be auditable: who, when, why, original intent.",
        "Never log full PANs, IBANs, or full SSNs — redact to last 4.",
        "All decimal arithmetic uses Decimal with explicit ROUND_HALF_EVEN.",
        "Reject negative amounts at the boundary; never assume callers validate.",
    ),
    required_skills=("audit-trail", "double-entry-ledger", "kyc-validators"),
    forbidden_patterns=(
        r"float\s*\(.*amount",
        r"print\(.*pan|print\(.*ssn",
        r"Decimal\([^)]*ROUND_HALF_UP",
    ),
    validation_rules=(
        "All ledger writes pass double-entry invariants (sum = 0)",
        "PAN/IBAN/SSN never appear unredacted in logs or responses",
        "All money math uses Decimal, never float",
        "Audit trail captures actor, timestamp, intent, and prior state",
    ),
    suggested_libraries={
        "python": ("decimal (stdlib)", "structlog", "schwifty"),
        "c#": ("System.Decimal", "NodaMoney", "Serilog", "IbanNet"),
        "javascript/typescript": ("dinero.js", "pino", "ibantools"),
        "java/kotlin": (
            "java.math.BigDecimal",
            "org.javamoney:moneta",
            "org.iban4j:iban4j",
        ),
        "go": ("github.com/shopspring/decimal", "github.com/Rhymond/go-money"),
        "php": ("moneyphp/money", "brick/math"),
        "ruby": ("bigdecimal", "money"),
        "rust": ("rust_decimal", "iban_validate"),
        "dart": ("decimal",),
    },
)

_HEALTHCARE = DomainProfile(
    tag=DomainTag.HEALTHCARE,
    label="Healthcare",
    description="EHR, PHI, HIPAA-aware data flows.",
    guardrails=(
        "Any field that could identify a patient is PHI — encrypt at rest, audit access.",
        "Never include PHI in error messages or stack traces sent to third parties.",
        "All access to PHI must be logged with the actor identity and purpose.",
        "Default-deny: opt patients in to data sharing rather than out.",
        "Maintain a Business Associate Agreement (BAA) with every third-party processor you call.",
    ),
    required_skills=("phi-encryption", "audit-trail", "consent-tracking"),
    forbidden_patterns=(
        r"print\(.*patient",
        r"logger\.(info|debug)\(.*ssn",
        r"json\.dumps\(.*medical_record_number",
    ),
    validation_rules=(
        "PHI columns are encrypted at rest (column-level or DB-level)",
        "Every PHI read is recorded in an immutable audit log",
        "Outbound integrations only call BAA-approved processors",
        "Patient consent is checked before any data sharing path",
    ),
    suggested_libraries={
        "python": ("cryptography", "fhir.resources", "structlog"),
        "c#": ("Hl7.Fhir.R4", "Serilog"),
        "javascript/typescript": ("pino",),
        "java/kotlin": ("ca.uhn.hapi.fhir:hapi-fhir-structures-r4",),
    },
)

_GAMING = DomainProfile(
    tag=DomainTag.GAMING,
    label="Gaming",
    description="Realtime multiplayer, anti-cheat, telemetry.",
    guardrails=(
        "Authoritative state lives on the server — never trust client positions or scores.",
        "Run physics/game logic at a fixed tick rate; reconcile client predictions.",
        "Rate-limit player actions at the server boundary (anti-cheat baseline).",
        "Telemetry events must be batchable + lossy-acceptable; don't block gameplay on writes.",
    ),
    required_skills=("server-authority", "tick-loop", "telemetry-batching"),
    forbidden_patterns=(
        r"client_provided_score",
        r"trust_client",
    ),
    validation_rules=(
        "All score changes go through the server simulation",
        "Action endpoints have per-player rate limits",
        "Game loop runs at a fixed tick (no wall-clock-based deltas in physics)",
    ),
    suggested_libraries={
        "python": ("websockets", "msgpack"),
        "c#": ("MessagePack", "Microsoft.AspNetCore.SignalR.Client"),
        "javascript/typescript": ("ws", "@msgpack/msgpack"),
        "java/kotlin": ("org.msgpack:msgpack-core",),
        "go": ("github.com/gorilla/websocket", "github.com/vmihailenco/msgpack/v5"),
        "rust": ("tokio-tungstenite", "rmp-serde"),
        "dart": ("web_socket_channel",),
    },
)

_IOT = DomainProfile(
    tag=DomainTag.IOT,
    label="IoT",
    description="Embedded devices, intermittent connectivity, OTA updates.",
    guardrails=(
        "Network is unreliable: always have an offline queue + retry.",
        "Firmware updates must support rollback; never brick on partial flash.",
        "Devices have constrained memory: prefer streaming over buffering.",
        "Authentication uses per-device keys, not a shared secret.",
    ),
    required_skills=("ota-updates", "offline-queue", "device-attestation"),
    forbidden_patterns=(
        r"hardcoded_device_secret",
        r"shared_api_key",
    ),
    validation_rules=(
        "Outbound calls degrade to a local queue when offline",
        "OTA pipeline ships A/B partitions or supports rollback",
        "Each device has a unique credential",
    ),
    suggested_libraries={
        "python": ("paho-mqtt",),
        "c#": ("MQTTnet",),
        "javascript/typescript": ("mqtt",),
        "java/kotlin": ("org.eclipse.paho:org.eclipse.paho.client.mqttv3",),
        "go": ("github.com/eclipse/paho.mqtt.golang",),
        "rust": ("rumqttc",),
        "dart": ("mqtt_client",),
    },
)

_GOVTECH = DomainProfile(
    tag=DomainTag.GOVTECH,
    label="GovTech",
    description="Public-sector workflows: accessibility, audit, FOIA-readiness.",
    guardrails=(
        "Every UI must hit WCAG 2.1 AA — colour contrast, keyboard, screen-reader labels.",
        "All data submitted by citizens must be retrievable for audit / FOIA.",
        "Forms must save partial progress and survive session loss.",
        "Available in the agency's official languages.",
    ),
    required_skills=("a11y-checks", "audit-trail", "i18n-bilingual"),
    forbidden_patterns=(),
    validation_rules=(
        "Lighthouse / axe accessibility audit passes at AA",
        "All citizen-submitted data is queryable by submission ID",
        "Form drafts persist across sessions",
    ),
    suggested_libraries={
        "javascript/typescript": ("axe-core", "@axe-core/playwright"),
        "c#": ("Deque.AxeCore.Playwright",),
        "java/kotlin": ("com.deque.html.axe-core:playwright",),
        "python": ("axe-selenium-python",),
    },
)

_EDUCATION = DomainProfile(
    tag=DomainTag.EDUCATION,
    label="Education",
    description="Edtech: minor users, FERPA-aware, classroom workflows.",
    guardrails=(
        "Treat all user data as student data — FERPA / COPPA-compliant by default.",
        "Never expose grades or progress to other students.",
        "Default to teacher-mediated communication, not student-to-student.",
        "Content must be flagged with age-appropriateness metadata.",
    ),
    required_skills=("ferpa-redaction", "role-based-access"),
    forbidden_patterns=(r"public_grade|public_score",),
    validation_rules=(
        "Authorisation checks separate student / teacher / parent / admin roles",
        "Grade access is scoped to the owner + their teacher(s)",
    ),
    suggested_libraries={},
)

_SAAS = DomainProfile(
    tag=DomainTag.SAAS,
    label="SaaS / B2B",
    description="Multi-tenant SaaS with billing, RBAC, audit.",
    guardrails=(
        "Every query MUST be scoped by tenant_id — no cross-tenant data leak.",
        "RBAC checks happen in middleware, not sprinkled in handlers.",
        "Background jobs inherit the tenant context — never run unscoped.",
        "All billing-relevant events go through the metering pipeline.",
    ),
    required_skills=("tenant-isolation", "rbac-middleware", "metered-events"),
    forbidden_patterns=(
        r"\.query\([^)]*\)\s*$",  # raw query without filter — heuristic
        r"select\s+\*\s+from\s+\w+\s*;",
    ),
    validation_rules=(
        "Every read/write is parameterised by tenant_id",
        "Background workers receive tenant context explicitly",
        "Metering events fire on every billable action",
    ),
    suggested_libraries={
        "python": ("pydantic", "sqlalchemy"),
        "c#": ("Finbuckle.MultiTenant",),
    },
)

_DATA_PIPELINE = DomainProfile(
    tag=DomainTag.DATA_PIPELINE,
    label="Data Pipeline",
    description="ETL, batch jobs, data quality.",
    guardrails=(
        "Every pipeline step must be idempotent and resumable.",
        "Data validation happens at every boundary — schema-on-read is not enough.",
        "Pipeline failure must be observable: emit metrics + structured error.",
        "Backfills must be safe to run twice without double-counting.",
    ),
    required_skills=("idempotency-keys", "schema-validation", "lineage-tracking"),
    forbidden_patterns=(
        r"INSERT\s+INTO[^;]*;",  # raw insert without conflict handling
    ),
    validation_rules=(
        "Each step is rerunnable with no side effects",
        "Inputs and outputs validate against an explicit schema",
        "Failures emit a structured event consumable by the alerting pipeline",
    ),
    suggested_libraries={
        "python": ("pydantic", "great-expectations"),
        "javascript/typescript": ("zod",),
    },
)


_CATALOGUE: dict[DomainTag, DomainProfile] = {
    p.tag: p
    for p in (
        _GENERIC,
        _ECOMMERCE,
        _FINTECH,
        _HEALTHCARE,
        _GAMING,
        _IOT,
        _GOVTECH,
        _EDUCATION,
        _SAAS,
        _DATA_PIPELINE,
    )
}


# ----------------------------------------------------------------------
# Bundle


@dataclass
class DomainAgentBundle:
    """The factory output — ready to inject into existing agents."""

    domain: DomainTag
    role: AgentRole
    profile: DomainProfile
    prompt_addendum: str
    required_skills: list[str] = field(default_factory=list)
    guardrails: list[str] = field(default_factory=list)
    forbidden_patterns: list[str] = field(default_factory=list)
    validation_rules: list[str] = field(default_factory=list)
    suggested_libraries: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "suggested_libraries": self.suggested_libraries,
            "domain": self.domain.value,
            "role": self.role.value,
            "profile": self.profile.to_dict(),
            "prompt_addendum": self.prompt_addendum,
            "required_skills": self.required_skills,
            "guardrails": self.guardrails,
            "forbidden_patterns": self.forbidden_patterns,
            "validation_rules": self.validation_rules,
        }


# ----------------------------------------------------------------------
# Factory


class DomainAgentFactory:
    """Compose a `DomainProfile` with an `AgentRole` into a bundle."""

    def list_domains(self) -> list[dict]:
        """For UI: list all available domains with their labels & descriptions."""
        return [
            {
                "tag": p.tag.value,
                "label": p.label,
                "description": p.description,
            }
            for p in _CATALOGUE.values()
        ]

    def get_profile(self, domain: DomainTag | str) -> DomainProfile:
        tag = DomainTag(domain) if isinstance(domain, str) else domain
        if tag not in _CATALOGUE:
            raise ValueError(f"Unknown domain {tag!r}")
        return _CATALOGUE[tag]

    def build(
        self,
        domain: DomainTag | str,
        role: AgentRole | str,
        languages: list[str] | None = None,
    ) -> DomainAgentBundle:
        """Compose a bundle for `(domain, role)`.

        ``languages`` are the project's stacks (`project.stack.detect_languages`):
        library advice is given for those only, none when the list is empty,
        every stack's when it is None (the app's preview, which has no project).
        """
        domain_tag = DomainTag(domain) if isinstance(domain, str) else domain
        role_value = AgentRole(role) if isinstance(role, str) else role

        profile = self.get_profile(domain_tag)
        libraries = profile.libraries_for(languages)
        addendum = self._build_prompt_addendum(profile, role_value, libraries)

        # The role narrows the set of guardrails / rules we surface.
        guardrails = list(profile.guardrails)
        validation_rules = (
            list(profile.validation_rules)
            if role_value in (AgentRole.REVIEWER, AgentRole.PLANNER, AgentRole.CODER)
            else []
        )
        forbidden = (
            list(profile.forbidden_patterns)
            if role_value in (AgentRole.CODER, AgentRole.REVIEWER)
            else []
        )
        required_skills = (
            list(profile.required_skills) if role_value != AgentRole.DOCUMENTER else []
        )

        return DomainAgentBundle(
            domain=domain_tag,
            role=role_value,
            profile=profile,
            prompt_addendum=addendum,
            required_skills=required_skills,
            guardrails=guardrails,
            forbidden_patterns=forbidden,
            validation_rules=validation_rules,
            suggested_libraries=libraries,
        )

    # ------------------------------------------------------------------
    # Prompt assembly

    def _build_prompt_addendum(
        self,
        profile: DomainProfile,
        role: AgentRole,
        libraries: dict[str, list[str]],
    ) -> str:
        if profile.tag == DomainTag.GENERIC:
            return ""

        sections: list[str] = []
        sections.append(f"## Domain context: {profile.label}\n{profile.description}")

        if profile.guardrails:
            sections.append(
                "### Domain guardrails — these are non-negotiable\n"
                + "\n".join(f"- {g}" for g in profile.guardrails)
            )

        if role in (AgentRole.CODER, AgentRole.REVIEWER) and profile.forbidden_patterns:
            sections.append(
                "### Forbidden patterns — never write code matching these (regex):\n"
                + "\n".join(f"- `{p}`" for p in profile.forbidden_patterns)
            )

        if role in (AgentRole.REVIEWER, AgentRole.PLANNER) and profile.validation_rules:
            sections.append(
                "### Validation rules — verify these explicitly before approving:\n"
                + "\n".join(f"- {r}" for r in profile.validation_rules)
            )

        if role == AgentRole.PLANNER and profile.required_skills:
            sections.append(
                "### Required skills — make sure these are activated for the spec:\n"
                + "\n".join(f"- `{s}`" for s in profile.required_skills)
            )

        if libraries:
            lines: list[str] = []
            for lang, libs in libraries.items():
                prefix = f"{lang}: " if len(libraries) > 1 else ""
                lines.append(f"- {prefix}" + ", ".join(f"`{lib}`" for lib in libs))
            sections.append(
                "### Suggested libraries — prefer these over hand-rolled implementations:\n"
                + "\n".join(lines)
            )

        return "\n\n".join(sections)
