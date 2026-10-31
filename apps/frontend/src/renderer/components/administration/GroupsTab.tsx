/**
 * Groups of people: give a team its access once instead of person by person.
 *
 * A group's members inherit its organization role and its role on each
 * project it is given, always on top of their own: a group never takes a
 * right away. Who may change a group is the server's call; the controls are
 * hidden from someone who would get a 403 (`org.member.write` for the group
 * and its members, `project.member.write` for its projects).
 */
import { Plus, Trash2, UsersRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Label } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";
import type { GroupProjectRole } from "../../../preload/api/modules/server-admin-api";

const PROJECT_ROLES: readonly GroupProjectRole[] = ["viewer", "member", "owner"];

const SELECT =
	"bg-background border border-border rounded px-2 py-1 text-sm disabled:opacity-60";

export function GroupsTab() {
	const { t } = useTranslation("administration");
	const groups = useAdminStore((s) => s.groups);
	const roles = useAdminStore((s) => s.roles);
	const members = useAdminStore((s) => s.members);
	const projects = useAdminStore((s) => s.groupProjects);
	const loadGroups = useAdminStore((s) => s.loadGroups);
	const loadRoles = useAdminStore((s) => s.loadRoles);
	const loadMembers = useAdminStore((s) => s.loadMembers);
	const loadGroupProjects = useAdminStore((s) => s.loadGroupProjects);
	const createGroup = useAdminStore((s) => s.createGroup);
	const updateGroup = useAdminStore((s) => s.updateGroup);
	const deleteGroup = useAdminStore((s) => s.deleteGroup);
	const setGroupMember = useAdminStore((s) => s.setGroupMember);
	const setGroupProjectRole = useAdminStore((s) => s.setGroupProjectRole);

	const canWrite = usePermission("org.member.write");
	const canGrantProjects = usePermission("project.member.write");

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftDescription, setDraftDescription] = useState("");
	const [newMember, setNewMember] = useState("");
	const [newProject, setNewProject] = useState("");
	const [newProjectRole, setNewProjectRole] = useState<GroupProjectRole>("member");

	useEffect(() => {
		void loadGroups();
		void loadRoles();
		void loadMembers();
		void loadGroupProjects();
	}, [loadGroups, loadRoles, loadMembers, loadGroupProjects]);

	const orgRoles = roles.filter((role) => role.scope === "org");
	const selected = groups.find((g) => g.id === selectedId) ?? groups[0] ?? null;
	const inGroup = new Set(selected?.members.map((m) => m.user_id) ?? []);
	const granted = new Set(selected?.projects.map((p) => p.project_id) ?? []);
	const addableMembers = members.filter((m) => !inGroup.has(m.user_id));
	const addableProjects = projects.filter((p) => !granted.has(p.id));

	async function submitNewGroup() {
		const ok = await createGroup({
			name: draftName.trim(),
			description: draftDescription.trim(),
		});
		if (ok) {
			setCreating(false);
			setDraftName("");
			setDraftDescription("");
		}
	}

	return (
		<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-medium">{t("groups.title")}</h3>
					{canWrite && (
						<Button size="sm" variant="outline" onClick={() => setCreating(true)}>
							<Plus className="h-4 w-4 mr-1" />
							{t("groups.create")}
						</Button>
					)}
				</div>
				<p className="text-xs text-muted-foreground">{t("groups.description")}</p>

				{groups.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("groups.empty")}</p>
				) : (
					<ul className="divide-y divide-border rounded-md border border-border">
						{groups.map((group) => (
							<li key={group.id}>
								<button
									type="button"
									className={`w-full text-left p-3 hover:bg-muted/50 ${
										selected?.id === group.id && !creating ? "bg-muted" : ""
									}`}
									onClick={() => {
										setCreating(false);
										setSelectedId(group.id);
									}}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="font-medium text-sm">{group.name}</span>
										{group.role_name && (
											<Badge variant="secondary">{group.role_name}</Badge>
										)}
									</div>
									<p className="text-xs text-muted-foreground mt-1">
										{t("groups.summary", {
											members: group.members.length,
											projects: group.projects.length,
										})}
									</p>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="lg:col-span-2 space-y-4">
				{creating && (
					<div className="border border-border rounded-md p-4 space-y-3">
						<h3 className="text-sm font-medium">{t("groups.newGroup")}</h3>
						<div className="space-y-1">
							<Label htmlFor="group-name">{t("groups.name")}</Label>
							<Input
								id="group-name"
								value={draftName}
								maxLength={120}
								placeholder={t("groups.namePlaceholder")}
								onChange={(e) => setDraftName(e.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="group-description">{t("groups.descriptionLabel")}</Label>
							<Input
								id="group-description"
								value={draftDescription}
								maxLength={2000}
								onChange={(e) => setDraftDescription(e.target.value)}
							/>
						</div>
						<div className="flex gap-2">
							<Button size="sm" disabled={!draftName.trim()} onClick={submitNewGroup}>
								{t("groups.save")}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
								{t("common.cancel")}
							</Button>
						</div>
					</div>
				)}

				{!creating && selected && (
					<div className="border border-border rounded-md p-4 space-y-5">
						<div className="flex items-start justify-between gap-4">
							<div>
								<h3 className="text-base font-semibold flex items-center gap-2">
									<UsersRound className="h-4 w-4" />
									{selected.name}
								</h3>
								{selected.description && (
									<p className="text-sm text-muted-foreground">
										{selected.description}
									</p>
								)}
							</div>
							{canWrite && (
								<Button
									size="sm"
									variant="ghost"
									title={t("groups.delete")}
									onClick={() => void deleteGroup(selected.id)}
								>
									<Trash2 className="h-4 w-4 text-destructive" />
								</Button>
							)}
						</div>

						<div className="space-y-1">
							<Label htmlFor="group-role">{t("groups.orgRole")}</Label>
							<p className="text-xs text-muted-foreground">{t("groups.orgRoleHelp")}</p>
							<select
								id="group-role"
								className={SELECT}
								disabled={!canWrite}
								value={selected.role_slug ?? ""}
								onChange={(e) =>
									void updateGroup(selected.id, { role_slug: e.target.value })
								}
							>
								<option value="">{t("groups.noOrgRole")}</option>
								{orgRoles.map((role) => (
									<option key={role.id} value={role.slug}>
										{role.name}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<h4 className="text-sm font-medium">{t("groups.members")}</h4>
							{selected.members.length === 0 ? (
								<p className="text-xs text-muted-foreground">{t("groups.noMembers")}</p>
							) : (
								<ul className="space-y-1">
									{selected.members.map((member) => (
										<li
											key={member.user_id}
											className="flex items-center justify-between text-sm"
										>
											<span>
												{member.display_name}{" "}
												<span className="text-xs text-muted-foreground">
													{member.email}
												</span>
											</span>
											{canWrite && (
												<Button
													size="sm"
													variant="ghost"
													title={t("groups.removeMember")}
													onClick={() =>
														void setGroupMember(selected.id, member.user_id, false)
													}
												>
													<X className="h-4 w-4" />
												</Button>
											)}
										</li>
									))}
								</ul>
							)}
							{canWrite && addableMembers.length > 0 && (
								<div className="flex gap-2">
									<select
										className={SELECT}
										aria-label={t("groups.addMember")}
										value={newMember}
										onChange={(e) => setNewMember(e.target.value)}
									>
										<option value="">{t("groups.pickMember")}</option>
										{addableMembers.map((member) => (
											<option key={member.user_id} value={member.user_id}>
												{member.display_name}
											</option>
										))}
									</select>
									<Button
										size="sm"
										variant="outline"
										disabled={!newMember}
										onClick={async () => {
											if (await setGroupMember(selected.id, newMember, true)) {
												setNewMember("");
											}
										}}
									>
										{t("groups.addMember")}
									</Button>
								</div>
							)}
						</div>

						<div className="space-y-2">
							<h4 className="text-sm font-medium">{t("groups.projects")}</h4>
							<p className="text-xs text-muted-foreground">{t("groups.projectsHelp")}</p>
							{selected.projects.length === 0 ? (
								<p className="text-xs text-muted-foreground">{t("groups.noProjects")}</p>
							) : (
								<ul className="space-y-1">
									{selected.projects.map((project) => (
										<li
											key={project.project_id}
											className="flex items-center justify-between gap-2 text-sm"
										>
											<span>{project.name}</span>
											<span className="flex items-center gap-1">
												<select
													className={SELECT}
													aria-label={t("groups.projectRole")}
													disabled={!canGrantProjects}
													value={project.role}
													onChange={(e) =>
														void setGroupProjectRole(
															selected.id,
															project.project_id,
															e.target.value as GroupProjectRole,
														)
													}
												>
													{PROJECT_ROLES.map((role) => (
														<option key={role} value={role}>
															{t(`groups.projectRoles.${role}`)}
														</option>
													))}
												</select>
												{canGrantProjects && (
													<Button
														size="sm"
														variant="ghost"
														title={t("groups.removeProject")}
														onClick={() =>
															void setGroupProjectRole(
																selected.id,
																project.project_id,
																null,
															)
														}
													>
														<X className="h-4 w-4" />
													</Button>
												)}
											</span>
										</li>
									))}
								</ul>
							)}
							{canGrantProjects && addableProjects.length > 0 && (
								<div className="flex gap-2">
									<select
										className={SELECT}
										aria-label={t("groups.addProject")}
										value={newProject}
										onChange={(e) => setNewProject(e.target.value)}
									>
										<option value="">{t("groups.pickProject")}</option>
										{addableProjects.map((project) => (
											<option key={project.id} value={project.id}>
												{project.name}
											</option>
										))}
									</select>
									<select
										className={SELECT}
										aria-label={t("groups.projectRole")}
										value={newProjectRole}
										onChange={(e) =>
											setNewProjectRole(e.target.value as GroupProjectRole)
										}
									>
										{PROJECT_ROLES.map((role) => (
											<option key={role} value={role}>
												{t(`groups.projectRoles.${role}`)}
											</option>
										))}
									</select>
									<Button
										size="sm"
										variant="outline"
										disabled={!newProject}
										onClick={async () => {
											if (
												await setGroupProjectRole(
													selected.id,
													newProject,
													newProjectRole,
												)
											) {
												setNewProject("");
											}
										}}
									>
										{t("groups.addProject")}
									</Button>
								</div>
							)}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
