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
import type {
	PermissionDescriptor,
	RoleSummary,
} from "../../../preload/api/modules/server-admin-api";

function flip(set: Set<string>, key: string): Set<string> {
	const next = new Set(set);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * The permissions of one role, grouped by domain. Without `onToggle` the
 * boxes are read-only (a built-in role, or no right to change roles).
 */
function PermissionMatrix({
	title,
	byDomain,
	granted,
	onToggle,
	note,
	onDelete,
}: {
	readonly title: string;
	readonly byDomain: Record<string, PermissionDescriptor[]>;
	readonly granted: Set<string>;
	readonly onToggle?: (key: string) => void;
	readonly note?: string;
	readonly onDelete?: () => void;
}) {
	const { t } = useTranslation("administration");
	return (
		<div className="border border-border rounded-md p-4 space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">{title}</h3>
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						title={t("roles.delete")}
						aria-label={t("roles.delete")}
						onClick={onDelete}
					>
						<Trash2 className="h-4 w-4 text-destructive" />
					</Button>
				)}
			</div>

			{note && <p className="text-xs text-muted-foreground">{note}</p>}

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
									onToggle ? "cursor-pointer hover:bg-muted/50" : ""
								}`}
							>
								<input
									type="checkbox"
									checked={granted.has(permission.key)}
									disabled={!onToggle}
									onChange={() => onToggle?.(permission.key)}
								/>
								<span className="font-mono text-xs">{permission.action}</span>
								{permission.privileged && (
									<ShieldAlert
										className="h-3.5 w-3.5 text-destructive"
										role="img"
										aria-label={t("roles.privileged")}
									/>
								)}
							</label>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

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

	function toggleDraft(key: string) {
		setDraftPermissions((prev) => flip(prev, key));
	}

	function toggleRole(role: RoleSummary, key: string) {
		void updateRole(role.id, {
			permissions: [...flip(new Set(role.permissions), key)],
		});
	}

	function startCreating() {
		setCreating(true);
		setSelectedId(null);
		setDraftName("");
		setDraftSlug("");
		setDraftPermissions(new Set());
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
							onClick={startCreating}
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
									placeholder={t("administration:roles.namePlaceholder")}
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

				{creating && (
					<PermissionMatrix
						title={t("roles.newRole")}
						byDomain={byDomain}
						granted={draftPermissions}
						onToggle={toggleDraft}
					/>
				)}

				{!creating && selected && (
					<PermissionMatrix
						title={selected.name}
						byDomain={byDomain}
						granted={new Set(selected.permissions)}
						onToggle={
							canWrite && !selected.is_system
								? (key) => toggleRole(selected, key)
								: undefined
						}
						note={selected.is_system ? t("roles.builtInReadOnly") : undefined}
						onDelete={
							canWrite && !selected.is_system
								? () => void deleteRole(selected.id)
								: undefined
						}
					/>
				)}

				{!selected && !creating && (
					<p className="text-sm text-muted-foreground">{t("roles.selectPrompt")}</p>
				)}
			</section>
		</div>
	);
}
