/**
 * The task form's "Mobile platforms" box.
 *
 * On a project with a phone app, the Android / iOS boxes narrow the build to
 * the platforms checked, and a platform the app does not have is greyed out.
 * On a project without one (a Web API, a CLI…), the box says up front that
 * checking a platform adds setup tasks to the board — install the framework
 * and create the app, then prepare each platform — and that this task waits
 * for them; the framework proposed follows the project's stacks.
 */

import { Info, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	MOBILE_PLATFORMS,
	type MobilePlatform,
} from "../../../shared/types/mobile";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import type { MobileSetupState } from "./useMobileSetup";

interface MobileTargetsFieldsProps {
	targets: MobilePlatform[];
	onTargetsChange: (targets: MobilePlatform[]) => void;
	/** Absent: the box shows the plain description (no project to read). */
	setup?: MobileSetupState;
	disabled?: boolean;
	idPrefix: string;
}

export function MobileTargetsFields({
	targets,
	onTargetsChange,
	setup,
	disabled,
	idPrefix,
}: MobileTargetsFieldsProps) {
	const { t } = useTranslation(["mobile"]);
	const profile = setup?.profile;
	const hasApp = Boolean(profile?.isMobile && profile.stack);
	const noApp = Boolean(profile && !profile.isMobile && profile.frameworks?.length);
	const available = hasApp ? (profile?.stack?.platforms ?? []) : MOBILE_PLATFORMS;
	const plan = setup?.plan;
	const recommended = profile?.frameworks?.[0]?.id;

	return (
		<fieldset className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
			<legend className="text-sm font-medium text-foreground">
				{t("mobile:targets.label")}
			</legend>

			{noApp ? (
				<div
					className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-xs text-foreground"
					data-testid="mobile-setup-preamble"
				>
					<Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
					<div className="space-y-1">
						<p className="font-medium">{t("mobile:targets.noAppTitle")}</p>
						<p className="text-muted-foreground">
							{t("mobile:targets.noAppPreamble", {
								dir: profile?.mobileDir ?? "mobile",
							})}
						</p>
						{profile?.hostStacks && profile.hostStacks.length > 0 && (
							<p className="text-muted-foreground">
								{t("mobile:targets.hostStacks", {
									stacks: profile.hostStacks
										.map((stack) => t(`mobile:stacks.${stack}`, { defaultValue: stack }))
										.join(", "),
								})}
							</p>
						)}
					</div>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					{t("mobile:targets.description")}
				</p>
			)}

			{hasApp && profile?.stack && (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Smartphone className="h-3.5 w-3.5" />
					{t("mobile:targets.detected", {
						framework: t(`mobile:frameworks.${profile.stack.framework}`, {
							defaultValue: profile.stack.framework,
						}),
						platforms: profile.stack.platforms
							.map((platform) => t(`mobile:targets.${platform}`))
							.join(", "),
					})}
				</p>
			)}

			<div className="flex flex-wrap gap-4 pt-1">
				{MOBILE_PLATFORMS.map((platform) => {
					const missing = !available.includes(platform);
					return (
						<div key={platform} className="flex items-center gap-2">
							<Checkbox
								id={`${idPrefix}mobile-${platform}`}
								checked={targets.includes(platform)}
								disabled={disabled || (missing && !targets.includes(platform))}
								onCheckedChange={(checked) =>
									onTargetsChange(
										checked === true
											? [...targets, platform]
											: targets.filter((entry) => entry !== platform),
									)
								}
							/>
							<Label
								htmlFor={`${idPrefix}mobile-${platform}`}
								className="cursor-pointer text-sm text-foreground"
								title={missing ? t("mobile:targets.notInApp") : undefined}
							>
								{t(`mobile:targets.${platform}`)}
							</Label>
						</div>
					);
				})}
			</div>

			{plan && setup && (
				<div className="space-y-2 border-t border-border pt-3" data-testid="mobile-setup-plan">
					{setup.locked ? (
						<p className="text-xs text-muted-foreground">
							{t("mobile:targets.frameworkLocked", {
								framework: plan.framework.label,
							})}
						</p>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							<Label
								htmlFor={`${idPrefix}mobile-framework`}
								className="text-xs text-muted-foreground"
							>
								{t("mobile:targets.framework")}
							</Label>
							<NativeSelect
								id={`${idPrefix}mobile-framework`}
								value={plan.framework.id}
								disabled={disabled}
								onChange={(event) => setup.setFramework(event.target.value)}
							>
								{setup.choices.map((framework) => (
									<option key={framework.id} value={framework.id}>
										{framework.id === recommended
											? t("mobile:targets.recommended", { framework: framework.label })
											: framework.label}
									</option>
								))}
							</NativeSelect>
						</div>
					)}
					<p className="text-xs font-medium text-foreground">
						{t("mobile:targets.tasksHeading")}
					</p>
					<ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
						{[plan.install, ...plan.platforms].map((step) => (
							<li key={`${step.mark.step}-${step.mark.platform ?? ""}`}>
								{step.existing
									? t("mobile:targets.reused", { title: step.title })
									: step.title}
							</li>
						))}
						<li>{t("mobile:targets.thisTaskWaits")}</li>
					</ul>
				</div>
			)}
		</fieldset>
	);
}
