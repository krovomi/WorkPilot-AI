/**
 * Members of the organization: their role, whether the account is active, and
 * the sessions they currently hold.
 */
import { LogOut, Trash2, UserCheck, UserX } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";

export function MembersTab() {
	const { t } = useTranslation("administration");
	const members = useAdminStore((s) => s.members);
	const roles = useAdminStore((s) => s.roles);
	const sessions = useAdminStore((s) => s.sessions);
	const loadMembers = useAdminStore((s) => s.loadMembers);
	const loadRoles = useAdminStore((s) => s.loadRoles);
	const loadSessions = useAdminStore((s) => s.loadSessions);
	const setMemberRole = useAdminStore((s) => s.setMemberRole);
	const removeMember = useAdminStore((s) => s.removeMember);
	const setUserActive = useAdminStore((s) => s.setUserActive);
	const revokeSessions = useAdminStore((s) => s.revokeSessions);

	const canWrite = usePermission("org.member.write");
	const canRevoke = usePermission("org.session.revoke");
	const canSeeSessions = usePermission("org.session.read");

	useEffect(() => {
		void loadMembers();
		void loadRoles();
		if (canSeeSessions) void loadSessions();
	}, [loadMembers, loadRoles, loadSessions, canSeeSessions]);

	const sessionsByUser = sessions.reduce<Record<string, number>>((acc, session) => {
		acc[session.user_id] = (acc[session.user_id] ?? 0) + 1;
		return acc;
	}, {});

	if (members.length === 0) {
		return <p className="text-sm text-muted-foreground">{t("members.empty")}</p>;
	}

	return (
		<div className="border border-border rounded-md overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left">
						<th className="p-3 font-medium">{t("members.columns.user")}</th>
						<th className="p-3 font-medium">{t("members.columns.role")}</th>
						<th className="p-3 font-medium">{t("members.columns.status")}</th>
						{canSeeSessions && (
							<th className="p-3 font-medium">
								{t("members.columns.sessions")}
							</th>
						)}
						<th className="p-3 font-medium text-right">
							{t("members.columns.actions")}
						</th>
					</tr>
				</thead>
				<tbody>
					{members.map((member) => (
						<tr key={member.user_id} className="border-b border-border last:border-0">
							<td className="p-3">
								<div className="font-medium">{member.display_name}</div>
								<div className="text-xs text-muted-foreground">
									{member.email}
								</div>
							</td>
							<td className="p-3">
								{canWrite ? (
									<select
										className="bg-background border border-border rounded px-2 py-1 text-sm"
										value={member.role_slug}
										onChange={(e) =>
											void setMemberRole(member.user_id, e.target.value)
										}
										aria-label={t("members.columns.role")}
									>
										{roles.map((role) => (
											<option key={role.id} value={role.slug}>
												{role.name}
											</option>
										))}
									</select>
								) : (
									<Badge variant="secondary">{member.role_name}</Badge>
								)}
							</td>
							<td className="p-3">
								<Badge variant={member.is_active ? "success" : "muted"}>
									{member.is_active
										? t("members.active")
										: t("members.inactive")}
								</Badge>
							</td>
							{canSeeSessions && (
								<td className="p-3 text-muted-foreground">
									{sessionsByUser[member.user_id] ?? 0}
								</td>
							)}
							<td className="p-3">
								<div className="flex justify-end gap-1">
									{canRevoke && (sessionsByUser[member.user_id] ?? 0) > 0 && (
										<Button
											size="sm"
											variant="ghost"
											title={t("members.revokeSessions")}
											onClick={() => void revokeSessions(member.user_id)}
										>
											<LogOut className="h-4 w-4" />
										</Button>
									)}
									{canWrite && (
										<>
											<Button
												size="sm"
												variant="ghost"
												title={
													member.is_active
														? t("members.deactivate")
														: t("members.activate")
												}
												onClick={() =>
													void setUserActive(
														member.user_id,
														!member.is_active,
													)
												}
											>
												{member.is_active ? (
													<UserX className="h-4 w-4" />
												) : (
													<UserCheck className="h-4 w-4" />
												)}
											</Button>
											<Button
												size="sm"
												variant="ghost"
												title={t("members.remove")}
												onClick={() => void removeMember(member.user_id)}
											>
												<Trash2 className="h-4 w-4 text-destructive" />
											</Button>
										</>
									)}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
