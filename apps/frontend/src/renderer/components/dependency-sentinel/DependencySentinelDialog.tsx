import { Info, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDependencySentinelStore } from "../../stores/dependency-sentinel-store";
import { useProjectStore } from "../../stores/project-store";
import { CharterButton, Chip, Notice, Panel } from "../charter";
import "../charter/charter.css";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

/** The ecosystems whose manifests the dependency guard reads. */
const ECOSYSTEMS = [
	"npm",
	"PyPI",
	"NuGet",
	"Maven Central",
	"Go",
	"crates.io",
	"Packagist",
	"pub.dev",
	"RubyGems",
] as const;

/**
 * The dependency sentinel. It used to list a fixed set of packages and one
 * invented vulnerability whatever the project; it now says what WorkPilot
 * really checks: the packages a task adds, on every stack, against their
 * public registry (docs/architecture/dependency-guard.md).
 */
export function DependencySentinelDialog() {
	const { t } = useTranslation(["dialogs", "common"]);
	const { isOpen, closeDialog } = useDependencySentinelStore();
	const projectName = useProjectStore(
		(state) => state.projects.find((p) => p.id === state.selectedProjectId)?.name,
	);

	return (
		<Dialog open={isOpen} onOpenChange={closeDialog}>
			<DialogContent className="wp-scope max-w-2xl">
				<DialogHeader>
					<span className="wp-kicker">{t("dialogs:dependencySentinel.kicker")}</span>
					<DialogTitle className="wp-title flex items-center gap-2 text-lg">
						<ShieldCheck className="h-5 w-5" aria-hidden="true" />
						{t("dialogs:dependencySentinel.title")}
					</DialogTitle>
					<DialogDescription>
						{projectName
							? t("dialogs:dependencySentinel.descriptionFor", { name: projectName })
							: t("dialogs:dependencySentinel.description")}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<Panel rail tone="green">
						<p className="wp-title text-sm">{t("dialogs:dependencySentinel.guardTitle")}</p>
						<p className="wp-muted mt-1 text-xs">{t("dialogs:dependencySentinel.guardBody")}</p>
						<div className="wp-chips mt-2">
							{ECOSYSTEMS.map((name) => (
								<Chip key={name} tone="green" dot={false}>
									{name}
								</Chip>
							))}
						</div>
					</Panel>
					<Notice tone="amber" icon={Info}>
						{t("dialogs:dependencySentinel.auditPending")}
					</Notice>
				</div>

				<DialogFooter>
					<CharterButton variant="ghost" onClick={closeDialog}>
						{t("dialogs:dependencySentinel.close")}
					</CharterButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
