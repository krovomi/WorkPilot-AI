/**
 * "Guide d'intégration" tab of Intégration, in the UI charter
 * (docs/architecture/ui-charter.md): the steps of the path on the left, the
 * selected step on the right, the generate action in the composer.
 */
import { BookOpen, Footprints, RotateCcw, TriangleAlert, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { OnboardingGuide } from "../../../shared/types/onboarding";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import {
	CharterButton,
	Chip,
	Chips,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	StepCard,
} from "../charter";
import { useGeneratedText } from "./shared";

interface OnboardingGuideViewProps {
	readonly projectPath?: string;
}

type Step = OnboardingGuide["steps"][number];

function StepDetail({ step }: { readonly step: Step }): React.ReactElement {
	const { t } = useTranslation("onboardingAgent");
	const generated = useGeneratedText();
	return (
		<div className="flex flex-col gap-3">
			<Panel rail tone="blue">
				<span className="wp-kicker">{t("duration", { minutes: step.estimatedMinutes })}</span>
				<p className="mt-1 text-sm font-semibold">{generated(step.titleI18n, step.title)}</p>
				{step.lines && step.lines.length > 0 ? (
					<ul className="wp-muted mt-2 list-inside list-disc space-y-1 text-sm">
						{step.lines.map((line) => (
							<li key={`${line.key}:${line.fallback}`}>{generated(line)}</li>
						))}
					</ul>
				) : (
					<p className="wp-muted mt-2 whitespace-pre-wrap text-sm">{step.content}</p>
				)}
			</Panel>
			{step.commands.length > 0 && (
				<Panel>
					<span className="wp-kicker">{t("overview.commands")}</span>
					<div className="mt-2 flex flex-col gap-1.5">
						{step.commands.map((cmd) => (
							<pre key={cmd} className="wp-code !py-1.5">
								<span className="select-none text-primary">$ </span>
								{cmd}
							</pre>
						))}
					</div>
				</Panel>
			)}
		</div>
	);
}

export function OnboardingGuideView({ projectPath }: OnboardingGuideViewProps): React.ReactElement {
	const { t } = useTranslation("onboardingAgent");
	const generated = useGeneratedText();

	const phase = useOnboardingAgentStore((s) => s.phase);
	const status = useOnboardingAgentStore((s) => s.status);
	const guide = useOnboardingAgentStore((s) => s.guide);
	const error = useOnboardingAgentStore((s) => s.error);
	const startScan = useOnboardingAgentStore((s) => s.startScan);
	const cancelScan = useOnboardingAgentStore((s) => s.cancelScan);
	const reset = useOnboardingAgentStore((s) => s.reset);
	const [selected, setSelected] = useState(0);

	const isScanning = phase === "scanning";
	const steps = phase === "complete" && guide ? guide.steps : [];
	const current = steps[selected] ?? null;

	const handleRun = (): void => {
		if (!projectPath) return;
		setSelected(0);
		void startScan(projectPath);
	};

	return (
		<ModuleStage data-testid="onboarding-guide-view">
			<Columns template="minmax(280px, 36%) minmax(0, 1fr)">
				<Column
					kicker={t("kickers.guide")}
					title={guide?.projectName || t("title")}
					meta={guide ? t("duration", { minutes: guide.totalEstimatedMinutes }) : undefined}
					tone="blue"
				>
					<div className="flex flex-col gap-3">
						{guide && guide.techStack.length > 0 && (
							<Chips>
								{guide.techStack.map((tech) => (
									<Chip key={tech} tone="blue">
										{tech}
									</Chip>
								))}
							</Chips>
						)}
						{isScanning && <ScanLine label={status || t("actions.scanning")} />}
						{!isScanning && steps.length === 0 && (
							<EmptyStage icon={Footprints} title={t("guideEmptyTitle")} tone="blue">
								{phase === "complete" ? t("noData") : t("guideIntro")}
							</EmptyStage>
						)}
						{steps.map((step, index) => (
							<StepCard
								key={`${step.section}-${step.title}`}
								index={index + 1}
								tone="blue"
								kicker={t("kickers.step")}
								title={generated(step.titleI18n, step.title)}
								meta={t("duration", { minutes: step.estimatedMinutes })}
								active={index === selected}
								onClick={() => setSelected(index)}
							/>
						))}
					</div>
				</Column>
				<Column
					kicker={t("kickers.step")}
					title={current ? t("stepOfTotal", { current: selected + 1, total: steps.length }) : "—"}
					tone="violet"
				>
					{current ? (
						<div className="flex flex-col gap-3">
							<StepDetail step={current} />
							{guide?.summary && selected === steps.length - 1 && (
								<p className="wp-muted text-sm italic">{generated(guide.summaryI18n, guide.summary)}</p>
							)}
						</div>
					) : (
						<EmptyStage icon={BookOpen} title={t("title")} tone="violet">
							{t("selectStep")}
						</EmptyStage>
					)}
				</Column>
			</Columns>
			{(!projectPath || (phase === "error" && error)) && (
				<Notice tone="red" icon={TriangleAlert} role="alert" className="relative z-[2] mx-5 mb-2">
					{projectPath ? t("errors.failed", { error }) : t("errors.noProject")}
				</Notice>
			)}
			<Composer
				prompt={<span className="wp-muted truncate text-xs">{t("guideIntro")}</span>}
				hint={projectPath}
				actions={
					isScanning ? (
						<CharterButton icon={X} variant="danger" onClick={() => void cancelScan()}>
							{t("actions.cancel")}
						</CharterButton>
					) : (
						<>
							{phase === "complete" && (
								<CharterButton icon={RotateCcw} onClick={reset}>
									{t("actions.reset")}
								</CharterButton>
							)}
							<CharterButton variant="primary" icon={BookOpen} onClick={handleRun} disabled={!projectPath}>
								{phase === "complete" ? t("actions.regenerate") : t("actions.runScan")}
							</CharterButton>
						</>
					)
				}
			/>
		</ModuleStage>
	);
}
