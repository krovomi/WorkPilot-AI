import { AlertTriangle, Calendar, Package, Play, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useReleaseCoordinatorStore } from "../../stores/release-coordinator-store";
import { ReleaseTrainPanel } from "./ReleaseTrainPanel";
import type {
	BumpType,
	GateStatus,
	ReleaseTrainPlan,
} from "../../../shared/types/release-coordinator";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";

const GATE_TONES: Record<GateStatus, Tone> = {
	passed: "green",
	failed: "red",
	pending: "amber",
	skipped: "muted",
};

const BUMP_TONES: Record<BumpType, Tone> = {
	major: "red",
	minor: "amber",
	patch: "blue",
	none: "muted",
};

interface ReleasePlanViewProps {
	readonly projectPath?: string;
}

/** The release train: each service's next version, its gates, its changelog. */
export function ReleasePlanView({
	projectPath,
}: ReleasePlanViewProps): React.ReactElement {
	const { t } = useTranslation(["releaseCoordinator", "navigation"]);

	const phase = useReleaseCoordinatorStore((s) => s.phase);
	const status = useReleaseCoordinatorStore((s) => s.status);
	const plan = useReleaseCoordinatorStore((s) => s.plan);
	const error = useReleaseCoordinatorStore((s) => s.error);
	const startPlan = useReleaseCoordinatorStore((s) => s.startPlan);
	const cancelPlan = useReleaseCoordinatorStore((s) => s.cancelPlan);
	const reset = useReleaseCoordinatorStore((s) => s.reset);

	const isPlanning = phase === "planning";

	return (
		<ModuleStage scroll="page" data-testid="release-coordinator-view">
			<ModuleHeader
				kicker={t("navigation:groups.planning")}
				title={t("releaseCoordinator:title")}
				description={t("releaseCoordinator:description")}
				icon={Calendar}
				tone="violet"
				actions={
					<>
						{plan && !isPlanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("releaseCoordinator:actions.reset")}
							</CharterButton>
						)}
						{isPlanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelPlan()}>
								{t("releaseCoordinator:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && startPlan(projectPath)}
								disabled={!projectPath}
							>
								{t("releaseCoordinator:actions.runPlan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("releaseCoordinator:errors.noProject")}
					</Notice>
				)}
				{isPlanning && <ScanLine label={status || t("releaseCoordinator:actions.planning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("releaseCoordinator:errors.failed", { error })}
					</Notice>
				)}
				{plan ? (
					<PlanBody plan={plan} />
				) : (
					phase === "idle" && (
						<EmptyStage icon={Calendar} title={t("releaseCoordinator:emptyTitle")} tone="violet">
							{t("releaseCoordinator:noData")}
						</EmptyStage>
					)
				)}
				{projectPath && <ReleaseTrainPanel projectPath={projectPath} />}
			</Page>
		</ModuleStage>
	);
}

const semver = (v: { major: number; minor: number; patch: number }) =>
	`${v.major}.${v.minor}.${v.patch}`;

function PlanBody({ plan }: { readonly plan: ReleaseTrainPlan }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const bumped = plan.services.filter((s) => s.bumpType !== "none").length;
	const passed = plan.gates.filter((g) => g.status === "passed").length;

	return (
		<>
			<Stats>
				<Stat label={t("services")} value={plan.services.length} />
				<Stat label={t("kickers.bumped")} value={bumped} tone={bumped ? "amber" : "muted"} />
				<Stat
					label={t("gates")}
					value={`${passed}/${plan.gates.length}`}
					tone={passed === plan.gates.length ? "green" : "amber"}
				/>
				<Stat label={t("status")} value={t(`statuses.${plan.status}`, { defaultValue: plan.status })} tone="violet" />
			</Stats>

			{plan.gates.length > 0 && (
				<Section kicker={t("kickers.gates")} title={t("gates")}>
					<div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
						{plan.gates.map((gate) => (
							<Panel key={gate.name} rail tone={GATE_TONES[gate.status]}>
								<div className="flex items-start justify-between gap-2">
									<span className="wp-title text-sm">{gate.name}</span>
									<Chip tone={GATE_TONES[gate.status]}>
										{t(`gateStatuses.${gate.status}`, { defaultValue: gate.status })}
									</Chip>
								</div>
								{gate.message && <p className="wp-muted mt-1 text-xs">{gate.message}</p>}
							</Panel>
						))}
					</div>
				</Section>
			)}

			<Section kicker={t("kickers.services")} title={t("servicesTitle")}>
				{plan.services.length === 0 ? (
					<EmptyStage icon={Package} title={t("noServicesTitle")} tone="violet">
						{t("noServices")}
					</EmptyStage>
				) : (
					<div className="grid gap-2.5">
						{plan.services.map((svc) => (
							<Panel key={svc.name} rail tone={BUMP_TONES[svc.bumpType]}>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="wp-title text-sm">{svc.name}</span>
									<span className="font-mono text-xs">
										{semver(svc.currentVersion)} → {semver(svc.nextVersion)}
									</span>
								</div>
								<div className="wp-chips mt-2">
									<Chip tone={BUMP_TONES[svc.bumpType]}>
										{t(`bumpTypes.${svc.bumpType}`, { defaultValue: svc.bumpType })}
									</Chip>
									<Chip tone="muted" dot={false}>
										{t("changelogCount", { count: svc.changelogEntries.length })}
									</Chip>
								</div>
							</Panel>
						))}
					</div>
				)}
			</Section>

			<Notice tone={bumped ? "violet" : "muted"} icon={Calendar}>
				{bumped ? plan.summary : t("noVersionChanges")}
			</Notice>
		</>
	);
}
