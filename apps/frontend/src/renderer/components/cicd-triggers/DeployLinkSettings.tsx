/**
 * The services rolled back with this project, in the CI/CD settings (#366,
 * lot 4). The person picks other projects of the app (the frontend of this
 * backend, a worker); when a rollback of this project starts, each goes back
 * too, with its own CI/CD settings, to where it was when this project's last
 * good run was made. The choice is kept by the app, never in a repository.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import type { DeployLinksView } from "../../../shared/types/deploy-watch";
import { Switch } from "../ui/switch";

interface DeployLinkSettingsProps {
	readonly links: DeployLinksView | null;
	readonly onSave: (projectIds: string[]) => void;
}

export function DeployLinkSettings({ links, onSave }: DeployLinkSettingsProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const linked = links?.linked ?? [];
	const all = [...linked, ...(links?.candidates ?? [])].sort((a, b) => a.name.localeCompare(b.name));
	const chosen = new Set(linked.map((p) => p.id));
	const toggle = (id: string, on: boolean) =>
		onSave(on ? [...chosen, id] : [...chosen].filter((other) => other !== id));

	return (
		<div className="space-y-2.5 border-t border-border pt-3" data-testid="deploy-link-settings">
			<div className="wp-kicker">{t("cicdTriggers:links.heading")}</div>
			<p className="wp-meta">{t("cicdTriggers:links.description")}</p>
			{all.length === 0 ? (
				<p className="wp-meta">{t("cicdTriggers:links.none")}</p>
			) : (
				all.map((project) => (
					<label
						key={project.id}
						htmlFor={`cicd-link-${project.id}`}
						className="flex cursor-pointer items-center justify-between gap-3 text-sm"
					>
						<span className="truncate">{project.name}</span>
						<Switch
							id={`cicd-link-${project.id}`}
							checked={chosen.has(project.id)}
							onCheckedChange={(checked) => toggle(project.id, checked)}
						/>
					</label>
				))
			)}
		</div>
	);
}
