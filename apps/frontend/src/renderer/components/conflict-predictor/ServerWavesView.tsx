/**
 * The execution waves of a server project (#358), in server mode: the
 * server plans the backlog from its clone (cards that share no file run side
 * by side), runs "Execute in optimal order" wave after wave, and counts what
 * it avoided. The same routes as the mobile app's Waves page, read through
 * the main process by project id. Opening the view takes the run's next step
 * for someone who may start agents. The buttons only show what the person
 * may do; the server checks every action again (rule S5).
 */

import { AlertTriangle, Layers, Play, RefreshCw, Square, StepForward } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IPCResult, Project } from "../../../shared/types";
import type { WaveAdvanceWhen } from "../../../shared/types/conflict-waves";
import type {
	ServerWaveHistory,
	ServerWavePlan,
	ServerWaveRunAnswer,
} from "../../../shared/types/server-conflict-waves";
import { usePermission } from "../../stores/permissions-store";
import { CharterButton, Chip, Chips, EmptyStage, Notice, Panel, Section } from "../charter";
import { ServerHistoryPanel, ServerPlanPanel, ServerRunPanel } from "./ServerWavesParts";

const ADVANCE_RULES: readonly WaveAdvanceWhen[] = ["merged", "review"];

type Action = "start" | "step" | "stop";

interface Loaded {
	plan: ServerWavePlan;
	run: ServerWaveRunAnswer;
	history: ServerWaveHistory;
}

/** Why a call gave nothing: null when it answered. */
function failed(result: IPCResult<unknown>): string | null {
	return result.success && result.data ? null : (result.error ?? "");
}

/** Reads the plan, the run and the history; takes the run's next step when asked. */
export async function loadServerWaves(
	projectId: string,
	step: boolean,
): Promise<{ data: Loaded | null; error: string | null; failure: string | null }> {
	const api = window.electronAPI;
	const [plan, run, history] = await Promise.all([
		api.getServerWavePlan(projectId),
		api.getServerWaveRun(projectId),
		api.getServerWaveHistory(projectId),
	]);
	const error = failed(plan) ?? failed(run) ?? failed(history);
	if (error !== null) return { data: null, error, failure: null };
	const loaded: Loaded = {
		plan: plan.data as ServerWavePlan,
		run: run.data as ServerWaveRunAnswer,
		history: history.data as ServerWaveHistory,
	};
	if (!step || !loaded.run.run) return { data: loaded, error: null, failure: null };
	const stepped = await api.stepServerWaveRun(projectId);
	const failure = failed(stepped);
	return failure === null
		? { data: { ...loaded, run: stepped.data as ServerWaveRunAnswer }, error: null, failure: null }
		: { data: loaded, error: null, failure };
}

export function ServerWavesView({ project }: { project: Project }) {
	const { t } = useTranslation(["conflictPredictor", "common"]);
	const projectId = project.id;
	// The server wants a member of the project to run or stop the waves.
	const member = project.remote?.role !== "viewer";
	const mayRun = usePermission("agent.execute") && member;
	const mayStop = usePermission("task.write") && member;
	const [data, setData] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<Action | null>(null);
	const [advance, setAdvance] = useState<WaveAdvanceWhen>("merged");
	const [confirmStop, setConfirmStop] = useState(false);
	const load = useCallback(
		async (step: boolean) => {
			setLoading(true);
			const result = await loadServerWaves(projectId, step);
			setData(result.data);
			setError(result.error);
			if (result.failure !== null) setFailure(result.failure);
			setLoading(false);
		},
		[projectId],
	);

	// Shown under a key per project (`ServerMissionControl`): one view, one project.
	useEffect(() => {
		void load(mayRun);
	}, [load, mayRun]);

	const act = async (action: Action, call: () => Promise<IPCResult<ServerWaveRunAnswer>>) => {
		setBusy(action);
		setFailure(null);
		setConfirmStop(false);
		const why = failed(await call());
		if (why !== null) setFailure(why);
		setBusy(null);
		await load(false);
	};
	const api = window.electronAPI;
	const run = data?.run.run ?? null;

	return (
		<Section
			kicker={t("conflictPredictor:waves.kicker")}
			title={t("conflictPredictor:waves.title")}
			description={t("conflictPredictor:waves.server.intro")}
			actions={
				<CharterButton icon={RefreshCw} busy={loading} disabled={loading} onClick={() => void load(false)}>
					{t("common:buttons.refresh")}
				</CharterButton>
			}
		>
			<div className="space-y-3" data-testid="server-execution-waves">
				{error !== null && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("conflictPredictor:waves.server.loadError", { error })}
					</Notice>
				)}
				{failure !== null && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("conflictPredictor:waves.server.actionError", { error: failure })}
					</Notice>
				)}
				{!data ? (
					error === null && <EmptyStage icon={Layers} tone="orange" title={t("conflictPredictor:waves.server.loading")} />
				) : (
					<>
						{run ? (
							<>
								<ServerRunPanel answer={{ ...data.run, run }} />
								<RunControls
									mayRun={mayRun}
									mayStop={mayStop}
									busy={busy}
									confirmStop={confirmStop}
									onStep={() => void act("step", () => api.stepServerWaveRun(projectId))}
									onAskStop={() => setConfirmStop(true)}
									onCancelStop={() => setConfirmStop(false)}
									onStop={() => void act("stop", () => api.stopServerWaveRun(projectId))}
								/>
							</>
						) : (
							<Panel className="space-y-2" data-testid="server-wave-execute">
								<p className="wp-kicker">{t("conflictPredictor:waves.actions.execute")}</p>
								{data.run.ended === "done" && <p className="wp-meta">{t("conflictPredictor:waves.server.finished")}</p>}
								{data.run.ignored && <p className="wp-meta">{t("conflictPredictor:waves.server.ignored")}</p>}
								{mayRun && data.plan.waves.length > 0 ? (
									<div className="flex flex-wrap items-center gap-2">
										<span className="wp-meta">{t("conflictPredictor:waves.options.advance")}</span>
										<Chips>
											{ADVANCE_RULES.map((rule) => (
												<Chip key={rule} dot={false} pressed={advance === rule} onClick={() => setAdvance(rule)}>
													{rule === "merged"
														? t("conflictPredictor:waves.options.advanceMerged")
														: t("conflictPredictor:waves.options.advanceReview")}
												</Chip>
											))}
										</Chips>
										<CharterButton
											icon={Play}
											variant="primary"
											busy={busy === "start"}
											disabled={busy !== null}
											onClick={() => void act("start", () => api.startServerWaveRun(projectId, advance))}
										>
											{t("conflictPredictor:waves.server.start")}
										</CharterButton>
									</div>
								) : (
									<p className="wp-meta">
										{data.plan.waves.length > 0
											? t("conflictPredictor:waves.server.noRight")
											: t("conflictPredictor:waves.server.empty")}
									</p>
								)}
							</Panel>
						)}
						<ServerPlanPanel plan={data.plan} />
						<ServerHistoryPanel history={data.history} />
					</>
				)}
			</div>
		</Section>
	);
}

interface RunControlsProps {
	mayRun: boolean;
	mayStop: boolean;
	busy: Action | null;
	confirmStop: boolean;
	onStep: () => void;
	onAskStop: () => void;
	onCancelStop: () => void;
	onStop: () => void;
}

function RunControls({ mayRun, mayStop, busy, confirmStop, onStep, onAskStop, onCancelStop, onStop }: RunControlsProps) {
	const { t } = useTranslation(["conflictPredictor", "common"]);
	if (confirmStop) {
		return (
			<Notice tone="amber" icon={AlertTriangle} role="alert">
				<div className="flex flex-wrap items-center gap-2">
					<span className="min-w-0 flex-1">{t("conflictPredictor:waves.server.stopConfirm")}</span>
					<CharterButton icon={Square} size="sm" variant="danger" busy={busy === "stop"} onClick={onStop}>
						{t("conflictPredictor:waves.actions.stop")}
					</CharterButton>
					<CharterButton size="sm" variant="ghost" onClick={onCancelStop}>
						{t("common:buttons.cancel")}
					</CharterButton>
				</div>
			</Notice>
		);
	}
	if (!mayRun && !mayStop) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{mayRun && (
				<CharterButton icon={StepForward} busy={busy === "step"} disabled={busy !== null} onClick={onStep}>
					{t("conflictPredictor:waves.server.step")}
				</CharterButton>
			)}
			{mayStop && (
				<CharterButton icon={Square} variant="danger" disabled={busy !== null} onClick={onAskStop}>
					{t("conflictPredictor:waves.actions.stop")}
				</CharterButton>
			)}
		</div>
	);
}
