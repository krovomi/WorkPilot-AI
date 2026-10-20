/**
 * Tenants. Visible only to platform administrators — the deployment operator,
 * not a customer's own administrator.
 *
 * Suspending an organization degrades its members to read-only rather than
 * locking them out, so an admin can still see why it happened.
 */
import { Plus, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Label } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";

export function OrganizationsTab() {
	const { t } = useTranslation("administration");
	const organizations = useAdminStore((s) => s.organizations);
	const loadOrganizations = useAdminStore((s) => s.loadOrganizations);
	const createOrganization = useAdminStore((s) => s.createOrganization);
	const setOrganizationActive = useAdminStore((s) => s.setOrganizationActive);

	const isPlatformAdmin = usePermissionsStore((s) => s.isPlatformAdmin);
	const activeOrgId = usePermissionsStore((s) => s.orgId);
	const switchOrg = usePermissionsStore((s) => s.switchOrg);

	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");

	useEffect(() => {
		if (isPlatformAdmin) void loadOrganizations();
	}, [loadOrganizations, isPlatformAdmin]);

	if (!isPlatformAdmin) {
		return (
			<p className="text-sm text-muted-foreground">
				{t("organizations.platformAdminOnly")}
			</p>
		);
	}

	async function create() {
		const ok = await createOrganization({
			name: name.trim(),
			slug: slug.trim().toLowerCase(),
		});
		if (ok) {
			setName("");
			setSlug("");
		}
	}

	return (
		<div className="space-y-6">
			<section className="border border-border rounded-md p-4 space-y-3">
				<h3 className="text-sm font-medium">{t("organizations.create")}</h3>
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<Label htmlFor="org-name">{t("organizations.name")}</Label>
						<Input
							id="org-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="org-slug">{t("organizations.slug")}</Label>
						<Input
							id="org-slug"
							value={slug}
							placeholder="acme"
							onChange={(e) => setSlug(e.target.value)}
						/>
					</div>
				</div>
				<Button size="sm" disabled={!name.trim() || !slug.trim()} onClick={create}>
					<Plus className="h-4 w-4 mr-1" />
					{t("organizations.create")}
				</Button>
			</section>

			<div className="border border-border rounded-md overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border text-left">
							<th className="p-3 font-medium">{t("organizations.name")}</th>
							<th className="p-3 font-medium">{t("organizations.slug")}</th>
							<th className="p-3 font-medium">{t("organizations.status")}</th>
							<th className="p-3 font-medium text-right">
								{t("organizations.actions")}
							</th>
						</tr>
					</thead>
					<tbody>
						{organizations.map((org) => (
							<tr key={org.id} className="border-b border-border last:border-0">
								<td className="p-3 font-medium">
									{org.name}
									{org.id === activeOrgId && (
										<Badge variant="info" className="ml-2">
											{t("organizations.current")}
										</Badge>
									)}
								</td>
								<td className="p-3 font-mono text-xs">{org.slug}</td>
								<td className="p-3">
									<Badge variant={org.is_active ? "success" : "muted"}>
										{org.is_active
											? t("organizations.active")
											: t("organizations.suspended")}
									</Badge>
								</td>
								<td className="p-3">
									<div className="flex justify-end gap-1">
										{org.id !== activeOrgId && (
											<Button
												size="sm"
												variant="outline"
												onClick={() => void switchOrg(org.id)}
											>
												{t("organizations.switch")}
											</Button>
										)}
										<Button
											size="sm"
											variant="ghost"
											title={
												org.is_active
													? t("organizations.suspend")
													: t("organizations.reactivate")
											}
											onClick={() =>
												void setOrganizationActive(org.id, !org.is_active)
											}
										>
											<Power className="h-4 w-4" />
										</Button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
