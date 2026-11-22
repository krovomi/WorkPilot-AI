import { useTranslation } from "react-i18next";
import type { ProjectSettings } from "../../../shared/types";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Switch } from "../ui/switch";

/**
 * Where this project's long suites run (`apps/backend/test_placement/`).
 *
 * Automatic (the default) measures the machine against what the suite took
 * the last times and, when it lacks room, sends the suite to the forge's CI
 * or the WorkPilot server, else queues it on the machine. Manual picks this
 * machine or the CI. Automatic may push a task's branch without a pull
 * request to run the CI; that switch turns it off.
 */
export function ProjectTestPlacementSettings({
	settings,
	onChange,
}: {
	readonly settings: ProjectSettings;
	readonly onChange: (patch: Partial<ProjectSettings>) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const mode = settings.testPlacement ?? "auto";
	const automatic = mode === "auto";
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label htmlFor="test-placement-auto" className="font-normal text-foreground">
						{t("tasks:suitePlacement.project.label")}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t(
							automatic
								? "tasks:suitePlacement.project.autoHint"
								: "tasks:suitePlacement.project.manualHint",
						)}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">
						{t(
							automatic
								? "tasks:suitePlacement.modes.auto"
								: "tasks:suitePlacement.project.manual",
						)}
					</span>
					<Switch
						id="test-placement-auto"
						checked={automatic}
						onCheckedChange={(on) =>
							onChange({ testPlacement: on ? "auto" : "machine" })
						}
					/>
				</div>
			</div>
			{automatic ? (
				<div className="flex items-center justify-between">
					<div className="space-y-0.5">
						<Label
							htmlFor="test-placement-branch-push"
							className="font-normal text-foreground"
						>
							{t("tasks:suitePlacement.project.branchPush")}
						</Label>
						<p className="text-xs text-muted-foreground">
							{t("tasks:suitePlacement.project.branchPushHint")}
						</p>
					</div>
					<Switch
						id="test-placement-branch-push"
						checked={settings.testPlacementBranchPush !== false}
						onCheckedChange={(on) => onChange({ testPlacementBranchPush: on })}
					/>
				</div>
			) : (
				<RadioGroup
					value={mode}
					onValueChange={(value) =>
						onChange({ testPlacement: value === "ci" ? "ci" : "machine" })
					}
					aria-label={t("tasks:suitePlacement.project.label")}
				>
					{(["machine", "ci"] as const).map((choice) => (
						<div key={choice} className="flex items-start gap-2">
							<RadioGroupItem
								value={choice}
								id={`test-placement-${choice}`}
								className="mt-0.5"
							/>
							<div className="space-y-0.5">
								<Label
									htmlFor={`test-placement-${choice}`}
									className="font-normal text-foreground cursor-pointer"
								>
									{t(`tasks:suitePlacement.modes.${choice}`)}
								</Label>
								<p className="text-xs text-muted-foreground">
									{t(`tasks:suitePlacement.modeHints.${choice}`)}
								</p>
							</div>
						</div>
					))}
				</RadioGroup>
			)}
		</div>
	);
}
