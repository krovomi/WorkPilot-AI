/**
 * Admin-only invitation management (multi-user server mode).
 *
 * Lets an admin issue invitation links, see pending invitations and revoke
 * them. Account creation is invitation-only, so this is the entry point for
 * onboarding new users. The generated link is shown so it can be shared
 * manually when SMTP is disabled or delivery fails.
 */
import { Check, Copy, Loader2, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import type { InvitationPublic } from "../../../preload/api/modules/server-auth-api";
import type { RoleSummary } from "../../../preload/api/modules/server-admin-api";
import { formatAppDateTime } from "@/lib/date-format";
import { usePermissionsStore } from "@/stores/permissions-store";

import { NativeSelect } from "../ui/native-select";
import { SettingsSection } from "../settings/SettingsSection";

// The roles the server issues, shown in the app's language; another one is shown as the server names it.
const ROLE_KEYS: Record<string, string> = {
	member: "invitationsAdmin.roleMember",
	viewer: "invitationsAdmin.roleViewer",
	admin: "invitationsAdmin.roleAdmin",
};

export function InvitationsAdmin() {
	const { t } = useTranslation("settings");
	// A server administrator reaches every organization: only a platform
	// administrator may invite one, and the server refuses anyone else.
	const isPlatformAdmin = usePermissionsStore((s) => s.isPlatformAdmin);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	// The role in the organization; empty: the one the access above maps onto
	// (contributor for a member, viewer for a reader).
	const [orgRole, setOrgRole] = useState("");
	const [orgRoles, setOrgRoles] = useState<RoleSummary[]>([]);
	const [pending, setPending] = useState<InvitationPublic[]>([]);
	const [lastLink, setLastLink] = useState<string | null>(null);
	const [lastEmailSent, setLastEmailSent] = useState<boolean | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// "Copied" goes back to the copy icon after a moment, unless the view closed first.
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copiedTimer.current) clearTimeout(copiedTimer.current);
		},
		[],
	);

	// A rejected call (the main process refused it, the server is gone) is shown like a refusal.
	const failure = useCallback(
		(err: unknown) => setError(err instanceof Error ? err.message : String(err)),
		[],
	);

	const refresh = useCallback(async () => {
		try {
			const result = await window.electronAPI.serverAuth.listInvites();
			if (result.ok) setPending(result.data);
			else setError(result.error);
		} catch (err) {
			failure(err);
		}
	}, [failure]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Listing the roles needs `org.role.read`: without it, only the default
	// role is offered, and the server still decides.
	useEffect(() => {
		let cancelled = false;
		void window.electronAPI.serverAdmin
			?.listRoles()
			.then((result) => {
				if (!cancelled && result.ok) {
					setOrgRoles(result.data.filter((r) => r.scope !== "project"));
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const handleCreate = useCallback(async () => {
		setError(null);
		setLastLink(null);
		setBusy(true);
		try {
			const result = await window.electronAPI.serverAuth.createInvite({
				email: email.trim(),
				role,
				org_role: orgRole || null,
			});
			if (result.ok) {
				setLastLink(result.data.invite_link);
				setLastEmailSent(result.data.email_sent);
				setEmail("");
				await refresh();
			} else {
				setError(result.error);
			}
		} catch (err) {
			failure(err);
		} finally {
			setBusy(false);
		}
	}, [email, role, orgRole, refresh, failure]);

	const handleRevoke = useCallback(
		async (id: string) => {
			try {
				const result = await window.electronAPI.serverAuth.revokeInvite(id);
				if (result.ok) await refresh();
				else setError(result.error);
			} catch (err) {
				failure(err);
			}
		},
		[refresh, failure],
	);

	const handleCopy = useCallback(async (link: string) => {
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			setError(t("invitationsAdmin.copyFailed"));
			return;
		}
		setCopied(true);
		if (copiedTimer.current) clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), 1500);
	}, [t]);

	return (
		<SettingsSection
			title={t("invitationsAdmin.title")}
			description={t("invitationsAdmin.description")}
		>

			<div className="wp-card space-y-3 p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
					<div className="flex-1 space-y-2">
						<Label htmlFor="invite-email">
							{t("invitationsAdmin.email")}
						</Label>
						<Input
							id="invite-email"
							type="email"
							placeholder="person@example.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="invite-role">
							{t("invitationsAdmin.role")}
						</Label>
						<NativeSelect
							id="invite-role"
							className="h-9 px-3 text-sm"
							value={role}
							onChange={(e) => setRole(e.target.value)}
						>
							<option value="member">
								{t("invitationsAdmin.roleMember")}
							</option>
							<option value="viewer">
								{t("invitationsAdmin.roleViewer")}
							</option>
							{isPlatformAdmin && (
								<option value="admin">
									{t("invitationsAdmin.roleAdmin")}
								</option>
							)}
						</NativeSelect>
					</div>
					{orgRoles.length > 0 && (
						<div className="space-y-2">
							<Label htmlFor="invite-org-role">
								{t("invitationsAdmin.orgRole")}
							</Label>
							<NativeSelect
								id="invite-org-role"
								className="h-9 px-3 text-sm"
								value={orgRole}
								onChange={(e) => setOrgRole(e.target.value)}
							>
								<option value="">{t("invitationsAdmin.orgRoleDefault")}</option>
								{orgRoles.map((r) => (
									<option key={r.id} value={r.slug}>
										{r.name}
									</option>
								))}
							</NativeSelect>
						</div>
					)}
					<Button onClick={handleCreate} disabled={!email.trim() || busy}>
						{busy ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<UserPlus className="mr-2 h-4 w-4" />
						)}
						{t("invitationsAdmin.create")}
					</Button>
				</div>

				{lastLink && (
					<div className="space-y-2 rounded-md bg-muted/50 p-3">
						<p className="text-sm">
							{lastEmailSent
								? t("invitationsAdmin.emailSent")
								: t("invitationsAdmin.emailNotSent")}
						</p>
						<div className="flex items-center gap-2">
							<Input readOnly value={lastLink} className="flex-1 font-mono text-xs" />
							<Button
								variant="outline"
								size="sm"
								onClick={() => void handleCopy(lastLink)}
								aria-label={t("invitationsAdmin.copyLink")}
								title={t("invitationsAdmin.copyLink")}
							>
								{copied ? (
									<Check className="h-4 w-4" />
								) : (
									<Copy className="h-4 w-4" />
								)}
							</Button>
						</div>
					</div>
				)}
			</div>

			{error && (
				<p className="text-sm text-destructive" role="alert">
					{error}
				</p>
			)}

			<div className="space-y-2">
				<h4 className="text-sm font-medium">
					{t("invitationsAdmin.pending")}
				</h4>
				{pending.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("invitationsAdmin.none")}
					</p>
				) : (
					<ul className="divide-y divide-border rounded-lg border border-border">
						{pending.map((inv) => (
							<li
								key={inv.id}
								className="flex items-center justify-between gap-3 p-3"
							>
								<div className="min-w-0">
									<div className="truncate text-sm font-medium">{inv.email}</div>
									<div className="text-xs text-muted-foreground">
										{ROLE_KEYS[inv.role] ? t(ROLE_KEYS[inv.role]) : inv.role} ·{" "}
										{t("invitationsAdmin.expires")}{" "}
										{formatAppDateTime(inv.expires_at)}
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => handleRevoke(inv.id)}
									title={t("invitationsAdmin.revoke")}
								>
									<Trash2 className="h-4 w-4 text-destructive" />
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>
		</SettingsSection>
	);
}
