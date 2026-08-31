"""The permission catalog and the built-in roles must hold their invariants.

These are cheap structural checks, but each one stands in for a real failure
mode: a role granting a permission nothing implements is silently powerless, a
feature domain missing its read/write pair makes ``mount_guarded`` raise at
boot, and a "viewer" that accidentally acquires a write permission is a
privilege escalation nobody would notice by reading the diff.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz import catalog, roles  # noqa: E402


class TestCatalog:
    def test_keys_match_domain_and_action(self):
        for key, perm in catalog.PERMISSIONS.items():
            assert key == f"{perm.domain}.{perm.action}"

    def test_every_domain_is_declared(self):
        undeclared = sorted(
            {p.domain for p in catalog.PERMISSIONS.values()} - set(catalog.DOMAINS)
        )
        assert not undeclared, f"Domains missing from DOMAINS: {undeclared}"

    def test_validate_keys_rejects_unknown(self):
        with pytest.raises(ValueError, match="Unknown permission keys: task.teleport"):
            catalog.validate_keys(["task.read", "task.teleport"])

    def test_validate_keys_normalizes(self):
        assert catalog.validate_keys([" task.read ", "task.read", "agent.read"]) == [
            "agent.read",
            "task.read",
        ]

    def test_validate_keys_rejects_non_list(self):
        with pytest.raises(ValueError):
            catalog.validate_keys("task.read")

    def test_privileged_set_is_non_empty_and_consistent(self):
        assert catalog.PRIVILEGED_PERMISSION_KEYS
        for key in catalog.PRIVILEGED_PERMISSION_KEYS:
            assert catalog.PERMISSIONS[key].privileged

    def test_agent_execute_is_privileged(self):
        """Running an agent means executing code against a repository."""
        assert catalog.PERMISSIONS["agent.execute"].privileged
        assert catalog.PERMISSIONS["settings.provider.write"].privileged
        assert catalog.PERMISSIONS["org.role.write"].privileged

    def test_catalog_payload_is_serializable_and_sorted(self):
        payload = catalog.catalog_payload()
        assert len(payload) == len(catalog.PERMISSIONS)
        keys = [(p["domain"], p["action"]) for p in payload]
        assert keys == sorted(keys)


class TestFeatureDomains:
    def test_every_feature_domain_has_read_and_write(self):
        """``mount_guarded`` derives ``<domain>.read``/``.write`` from the verb.

        A feature mapped to a domain lacking either one raises at import, which
        would take the whole API down at boot.
        """
        missing = []
        for feature, domain in catalog.FEATURE_DOMAINS.items():
            for action in ("read", "write"):
                if f"{domain}.{action}" not in catalog.PERMISSIONS:
                    missing.append(f"{feature} -> {domain}.{action}")
        assert not missing, f"Feature domains missing permissions: {missing}"

    def test_domain_for_feature_raises_on_unknown(self):
        with pytest.raises(KeyError, match="Unknown feature"):
            catalog.domain_for_feature("not-a-feature")


class TestSystemRoles:
    def test_all_role_permissions_exist_in_the_catalog(self):
        for role in roles.SYSTEM_ROLES:
            unknown = sorted(role.permissions - catalog.ALL_PERMISSION_KEYS)
            assert not unknown, f"Role {role.slug!r} grants unknown: {unknown}"

    def test_slugs_are_unique(self):
        slugs = [r.slug for r in roles.SYSTEM_ROLES]
        assert len(slugs) == len(set(slugs))

    def test_viewer_can_only_read(self):
        viewer = roles.system_role("viewer")
        non_read = sorted(p for p in viewer.permissions if not p.endswith(".read"))
        assert not non_read, f"viewer holds non-read permissions: {non_read}"

    def test_viewer_holds_no_privileged_permission(self):
        for slug in ("viewer", "analyst", "reviewer"):
            role = roles.system_role(slug)
            assert not roles.privileged_in(role.permissions), (
                f"{slug} must not hold privileged permissions"
            )

    def test_no_org_role_grants_platform_permissions(self):
        """Cross-tenant power is never reachable from inside a tenant."""
        for role in roles.SYSTEM_ROLES:
            platform = sorted(p for p in role.permissions if p.startswith("platform."))
            assert not platform, f"{role.slug} grants platform perms: {platform}"

    def test_admin_covers_every_non_platform_permission(self):
        admin = roles.system_role("admin")
        expected = {
            k for k in catalog.ALL_PERMISSION_KEYS if not k.startswith("platform.")
        }
        assert admin.permissions == expected

    def test_contributor_cannot_merge_or_change_provider_credentials(self):
        contributor = roles.system_role("contributor")
        assert "task.merge" not in contributor.permissions
        assert "settings.provider.write" not in contributor.permissions
        assert "org.member.write" not in contributor.permissions

    def test_maintainer_extends_contributor(self):
        contributor = roles.system_role("contributor")
        maintainer = roles.system_role("maintainer")
        assert contributor.permissions <= maintainer.permissions

    def test_legacy_role_map_targets_real_system_roles(self):
        """The 0003 migration maps old global roles onto these."""
        for legacy, slug in roles.LEGACY_ROLE_MAP.items():
            assert slug in roles.SYSTEM_ROLE_SLUGS, f"{legacy} -> unknown role {slug}"
        assert roles.DEFAULT_ORG_ROLE in roles.SYSTEM_ROLE_SLUGS
