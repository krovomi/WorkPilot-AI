import { useTranslation } from "react-i18next";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

interface VerifyLoopFieldsProps {
	readonly verifyLoop?: boolean;
	readonly onVerifyLoopChange: (enabled: boolean) => void;
	/** The window a Windows app is verified in; without a handler, not shown. */
	readonly verifyWindow?: string;
	readonly onVerifyWindowChange?: (title: string) => void;
	/** The steps a web front end is verified with; without a handler, not shown. */
	readonly verifyScenario?: string;
	readonly onVerifyScenarioChange?: (steps: string) => void;
	readonly disabled?: boolean;
	readonly idPrefix?: string;
}

/**
 * The verification loop of a card: after coding, launch the app, fix what
 * breaks, drive it to the change and measure it. On unless the card or the
 * project turns it off. A Windows app is verified in one window, named here
 * by a part of its title (`verifyWindow`, read by `verify/window.py`). A web
 * front end can be verified by the steps written here (`verifyScenario`,
 * read by `verify/scenario.py`), followed in Playwright with a trace.
 */
export function VerifyLoopFields({
	verifyLoop,
	onVerifyLoopChange,
	verifyWindow,
	onVerifyWindowChange,
	verifyScenario,
	onVerifyScenarioChange,
	disabled = false,
	idPrefix = "",
}: VerifyLoopFieldsProps) {
	const { t } = useTranslation(["tasks"]);
	const prefix = idPrefix ? `${idPrefix}-` : "";
	const on = verifyLoop !== false;
	return (
		<div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30">
			<Checkbox
				id={`${prefix}verify-loop`}
				checked={on}
				onCheckedChange={(checked) => onVerifyLoopChange(checked === true)}
				disabled={disabled}
				className="mt-0.5"
			/>
			<div className="flex-1 space-y-1">
				<Label
					htmlFor={`${prefix}verify-loop`}
					className="text-sm font-medium text-foreground cursor-pointer"
				>
					{t("tasks:verify.form.label")}
				</Label>
				<p className="text-xs text-muted-foreground">{t("tasks:verify.form.hint")}</p>
				{onVerifyWindowChange && on && (
					<div className="space-y-1 pt-2">
						<Label htmlFor={`${prefix}verify-window`} className="text-xs font-medium text-foreground">
							{t("tasks:verify.form.windowLabel")}
						</Label>
						<Input
							id={`${prefix}verify-window`}
							value={verifyWindow ?? ""}
							maxLength={200}
							onChange={(event) => onVerifyWindowChange(event.target.value)}
							placeholder={t("tasks:verify.form.windowPlaceholder")}
							disabled={disabled}
							className="h-8 text-sm"
						/>
						<p className="text-xs text-muted-foreground">{t("tasks:verify.form.windowHint")}</p>
					</div>
				)}
				{onVerifyScenarioChange && on && (
					<div className="space-y-1 pt-2">
						<Label htmlFor={`${prefix}verify-scenario`} className="text-xs font-medium text-foreground">
							{t("tasks:verify.form.scenarioLabel")}
						</Label>
						<Textarea
							id={`${prefix}verify-scenario`}
							value={verifyScenario ?? ""}
							maxLength={4000}
							rows={4}
							onChange={(event) => onVerifyScenarioChange(event.target.value)}
							placeholder={t("tasks:verify.form.scenarioPlaceholder")}
							disabled={disabled}
							className="text-sm"
						/>
						<p className="text-xs text-muted-foreground">{t("tasks:verify.form.scenarioHint")}</p>
					</div>
				)}
			</div>
		</div>
	);
}
