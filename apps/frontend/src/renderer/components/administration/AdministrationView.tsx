/**
 * The administration console.
 *
 * Only meaningful in multi-user server mode: in local mode there is a single
 * implicit owner and nothing to administer, so the view says so rather than
 * rendering empty tables against an API that is not there.
 *
 * Each tab is gated by the permission its endpoints require, so a user sees the
 * parts of the console they can actually use. That is presentation, not
 * security — the server checks the same permissions on every request.
 */
import { AlertCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { InvitationsAdmin } from "@/components/auth/InvitationsAdmin";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { useServerSessionStore } from "@/stores/server-session-store";
import { AuditTab } from "./AuditTab";
import { MembersTab } from "./MembersTab";
import { OrganizationsTab } from "./OrganizationsTab";
import { OverviewTab } from "./OverviewTab";
import { QuotasTab } from "./QuotasTab";
import { RolesTab } from "./RolesTab";

type TabId =
	| "overview"
	| "members"
	| "roles"
	| "organizations"
	| "invitations"
	| "audit"
	| "quotas";

interface TabDef {
	readonly id: TabId;
	readonly labelKey: string;
	/** Permission required to see this tab at all. */
	readonly permission?: string;
	/** Platform administrators only (cross-tenant). */
	readonly platformOnly?: boolean;
}

const TABS: readonly TabDef[] = [
	{ id: "overview", labelKey: "tabs.overview", permission: "analytics.read" },
	{ id: "members", labelKey: "tabs.members", permission: "org.member.read" },
	{ id: "roles", labelKey: "tabs.roles", permission: "org.role.read" },
	{ id: "organizations", labelKey: "tabs.organizations", platformOnly: true },
	{
		id: "invitations",
		labelKey: "tabs.invitations",
		permission: "org.invitation.read",
	},
	{ id: "audit", labelKey: "tabs.audit", permission: "audit.read" },
	{ id: "quotas", labelKey: "tabs.quotas", permission: "org.quota.read" },
];

export function AdministrationView() {
	const { t } = useTranslation(["administration", "common"]);
	const serverMode = useServerSessionStore((s) => s.mode);

	const loaded = usePermissionsStore((s) => s.loaded);
	const isPlatformAdmin = usePermissionsStore((s) => s.isPlatformAdmin);
	const permissions = usePermissionsStore((s) => s.permissions);
	const unrestricted = usePermissionsStore((s) => s.unrestricted);
	const orgId = usePermissionsStore((s) => s.orgId);
	const organizations = usePermissionsStore((s) => s.organizations);
	const loadPermissions = usePermissionsStore((s) => s.load);
	const switchOrg = usePermissionsStore((s) => s.switchOrg);

	const error = useAdminStore((s) => s.error);
	const clearError = useAdminStore((s) => s.clearError);

	const [active, setActive] = useState<TabId>("overview");

	useEffect(() => {
		if (!loaded) void loadPermissions();
	}, [loaded, loadPermissions]);

	if (serverMode !== "server") {
		return (
			<div className="p-6">
				<div className="max-w-xl border border-border rounded-md p-6 text-center space-y-2">
					<ShieldCheck className="h-8 w-8 mx-auto text-muted-foreground" />
					<h2 className="text-lg font-semibold">{t("administration:localMode.title")}</h2>
					<p className="text-sm text-muted-foreground">
						{t("administration:localMode.description")}
					</p>
				</div>
			</div>
		);
	}

	const visible = TABS.filter((tab) => {
		if (tab.platformOnly) return isPlatformAdmin;
		if (!tab.permission) return true;
		return unrestricted || isPlatformAdmin || permissions.has(tab.permission);
	});

	const current = visible.some((tab) => tab.id === active)
		? active
		: (visible[0]?.id ?? "overview");

	return (
		<div className="p-6 space-y-6 overflow-auto h-full">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold flex items-center gap-2">
						<ShieldCheck className="h-6 w-6" />
						{t("administration:title")}
					</h1>
					<p className="text-sm text-muted-foreground">
						{t("administration:description")}
					</p>
				</div>

				{organizations.length > 1 && (
					<div className="flex items-center gap-2">
						<label
							htmlFor="admin-org"
							className="text-xs text-muted-foreground"
						>
							{t("administration:organizations.current")}
						</label>
						<select
							id="admin-org"
							className="bg-background border border-border rounded px-2 py-1 text-sm"
							value={orgId ?? ""}
							onChange={(e) => void switchOrg(e.target.value)}
						>
							{organizations.map((org) => (
								<option key={org.id} value={org.id}>
									{org.name}
								</option>
							))}
						</select>
					</div>
				)}
			</header>

			{error && (
				<div
					className="p-3 rounded-md border border-destructive/40 bg-destructive/10 text-sm flex items-start gap-2"
					role="alert"
				>
					<AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
					<span className="flex-1">{error}</span>
					<Button size="sm" variant="ghost" onClick={clearError}>
						{t("administration:common.dismiss")}
					</Button>
				</div>
			)}

			{visible.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{t("administration:noAccess")}
				</p>
			) : (
				<>
					<nav className="flex gap-1 border-b border-border overflow-x-auto">
						{visible.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => setActive(tab.id)}
								className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
									current === tab.id
										? "border-primary text-foreground font-medium"
										: "border-transparent text-muted-foreground hover:text-foreground"
								}`}
							>
								{t(`administration:${tab.labelKey}`)}
							</button>
						))}
					</nav>

					<div>
						{current === "overview" && <OverviewTab />}
						{current === "members" && <MembersTab />}
						{current === "roles" && <RolesTab />}
						{current === "organizations" && <OrganizationsTab />}
						{current === "invitations" && <InvitationsAdmin />}
						{current === "audit" && <AuditTab />}
						{current === "quotas" && <QuotasTab />}
					</div>
				</>
			)}
		</div>
	);
}
