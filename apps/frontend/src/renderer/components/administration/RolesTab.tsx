/**
 * Roles and the permission matrix.
 *
 * Built-in roles are shown but not editable — an upgrade that grants a new
 * permission to `admin` must reach every tenant, which it cannot do if each has
 * forked its own copy. An organization that needs something else builds a
 * custom role instead.
 *
 * Privileged permissions are called out visually: they are the ones that run
 * code, rewrite credentials or hand out access, and granting one should feel
 * different from granting "can read the board".
 */
import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Label } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";

export function RolesTab() {
	const { t } = useTranslation("administration");
	const roles = useAdminStore((s) => s.roles);
	const permissions = useAdminStore((s) => s.permissions);
	const loadRoles = useAdminStore((s) => s.loadRoles);
	const loadPermissions = useAdminStore((s) => s.loadPermissions);
	const createRole = useAdminStore((s) => s.createRole);
	const updateRole = useAdminStore((s) => s.updateRole);
	const deleteRole = useAdminStore((s) => s.deleteRole);

	const canWrite = usePermission("org.role.write");

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftSlug, setDraftSlug] = useState("");
	const [draftPermissions, setDraftPermissions] = useState<Set<string>>(new Set());

	useEffect(() => {
		void loadRoles();
		void loadPermissions();
	}, [loadRoles, loadPermissions]);

	const selected = roles.find((r) => r.id === selectedId) ?? null;

	const byDomain = useMemo(() => {
		const grouped: Record<string, typeof permissions> = {};
		for (const permission of permissions) {
			const bucket = grouped[permission.domain] ?? [];
			bucket.push(permission);
			grouped[permission.domain] = bucket;
		}
		return grouped;
	}, [permissions]);

	const activeSet = creating
		? draftPermissions
		: new Set(selected?.permissions ?? []);
	const editable = creating || (canWrite && selected !== null && !selected.is_system);

	function toggle(key: string) {
		if (!editable) return;
		if (creating) {
			setDraftPermissions((prev) => {
				const next = new Set(prev);
				next.has(key) ? next.delete(key) : next.add(key);
				return next;
			});
			return;
		}
		if (!selected) return;
		const next = new Set(selected.permissions);
		next.has(key) ? next.delete(key) : next.add(key);
		void updateRole(selected.id, { permissions: [...next] });
	}

	async function submitNewRole() {
		const ok = await createRole({
			slug: draftSlug.trim(),
			name: draftName.trim() || draftSlug.trim(),
			permissions: [...draftPermissions],
		});
		if (ok) {
			setCreating(false);
			setDraftName("");
			setDraftSlug("");
			setDraftPermissions(new Set());
		}
	}

	return (
		<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-medium">{t("roles.title")}</h3>
					{canWrite && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setCreating(true);
								setSelectedId(null);
								setDraftPermissions(new Set());
							}}
						>
							<Plus className="h-4 w-4 mr-1" />
							{t("roles.create")}
						</Button>
					)}
				</div>

				<ul className="divide-y divide-border rounded-md border border-border">
					{roles.map((role) => (
						<li key={role.id}>
							<button
								type="button"
								className={`w-full text-left p-3 hover:bg-muted/50 ${
									selectedId === role.id && !creating ? "bg-muted" : ""
								}`}
								onClick={() => {
									setCreating(false);
									setSelectedId(role.id);
								}}
							>
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium text-sm">{role.name}</span>
									{role.is_system ? (
										<Badge variant="secondary">{t("roles.builtIn")}</Badge>
									) : (
										<Badge variant="outline">{t("roles.custom")}</Badge>
									)}
								</div>
								<p className="text-xs text-muted-foreground mt-1">
									{t("roles.permissionCount", {
										count: role.permissions.length,
									})}
								</p>
							</button>
						</li>
					))}
				</ul>
			</section>

			<section className="lg:col-span-2 space-y-4">
				{creating && (
					<div className="border border-border rounded-md p-4 space-y-3">
						<h3 className="text-sm font-medium">{t("roles.newRole")}</h3>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label htmlFor="role-slug">{t("roles.slug")}</Label>
								<Input
									id="role-slug"
									value={draftSlug}
									placeholder="frontend-lead"
									onChange={(e) => setDraftSlug(e.target.value)}
								/>
							</div>
							<div className="space-y-1">
								<Label htmlFor="role-name">{t("roles.name")}</Label>
								<Input
									id="role-name"
									value={draftName}
									placeholder="Frontend Lead"
									onChange={(e) => setDraftName(e.target.value)}
								/>
							</div>
						</div>
						<div className="flex gap-2">
							<Button size="sm" disabled={!draftSlug.trim()} onClick={submitNewRole}>
								{t("roles.save")}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setCreating(false)}
							>
								{t("common.cancel")}
							</Button>
						</div>
					</div>
				)}

				{(selected || creating) && (
					<div className="border border-border rounded-md p-4 space-y-4">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">
								{creating ? t("roles.newRole") : selected?.name}
							</h3>
							{selected && !selected.is_system && canWrite && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => void deleteRole(selected.id)}
								>
									<Trash2 className="h-4 w-4 text-destructive" />
								</Button>
							)}
						</div>

						{selected?.is_system && (
							<p className="text-xs text-muted-foreground">
								{t("roles.builtInReadOnly")}
							</p>
						)}

						{Object.entries(byDomain).map(([domain, items]) => (
							<div key={domain} className="space-y-2">
								<h4 className="text-xs uppercase tracking-wider text-muted-foreground">
									{domain}
								</h4>
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
									{items.map((permission) => (
										<label
											key={permission.key}
											className={`flex items-center gap-2 text-sm p-1.5 rounded ${
												editable ? "cursor-pointer hover:bg-muted/50" : ""
											}`}
										>
											<input
												type="checkbox"
												checked={activeSet.has(permission.key)}
												disabled={!editable}
												onChange={() => toggle(permission.key)}
											/>
											<span className="font-mono text-xs">
												{permission.action}
											</span>
											{permission.privileged && (
												<ShieldAlert
													className="h-3.5 w-3.5 text-destructive"
													aria-label={t("roles.privileged")}
												/>
											)}
										</label>
									))}
								</div>
							</div>
						))}
					</div>
				)}

				{!selected && !creating && (
					<p className="text-sm text-muted-foreground">{t("roles.selectPrompt")}</p>
				)}
			</section>
		</div>
	);
}
