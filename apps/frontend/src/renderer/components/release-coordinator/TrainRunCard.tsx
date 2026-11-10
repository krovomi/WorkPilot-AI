import { AlertTriangle, Ban, CheckCircle2, Flag, Play, RotateCcw, Undo2 } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { ItemStatus, TrainItem, TrainRun } from "../../../shared/types/release-train";
import { formatAppTime } from "../../lib/date-format";
import { useReleaseTrainStore } from "../../stores/release-train-store";
import { CharterButton, Chip, Chips, Notice, Panel, type Tone } from "../charter";
import { RUN_TONES } from "./tones";

const ITEM_TONES: Record<ItemStatus, Tone> = {
	pending: "muted",
	waiting_confirmation: "amber",
	deploying: "blue",
	done: "green",
	failed: "red",
	rolled_back: "violet",
	rollback_failed: "red",
	skipped: "muted",
};

/** One run: each service's state, what it waits for, and the person's choices. */
export function TrainRunCard({ run }: { readonly run: TrainRun }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const busy = useReleaseTrainStore((s) => s.busy);
	const { act } = useReleaseTrainStore.getState();
	const waitingFlag = run.flags.find((f) => f.state === "waiting");
	const failed = run.blocked?.kind === "service" ? run.items.find((i) => i.service === run.blocked?.name) : undefined;

	return (
		<Panel rail tone={RUN_TONES[run.status]} className="mb-3" data-testid="train-run">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="wp-title text-sm">
					{run.express ? t("run.express", { environment: run.environment }) : t("run.title", { environment: run.environment })}
				</span>
				<Chip tone={RUN_TONES[run.status]}>{t(`runStatuses.${run.status}`)}</Chip>
			</div>
			{run.warnings.map((w) => (
				<Notice key={`${w.service}-${w.at}`} tone="amber" icon={AlertTriangle}>
					{t("run.calendarWarning", { service: w.service })}
				</Notice>
			))}
			<ul className="mt-2 space-y-2">
				{run.items.map((item) => (
					<ItemRow key={item.service} item={item} disabled={busy} onGo={() => act("confirm", item.service)} />
				))}
			</ul>
			{waitingFlag && (
				<Notice tone="amber" icon={Flag}>
					<span>{t("run.flagWaiting", { key: waitingFlag.key })}</span>
					<CharterButton
						className="ml-2"
						variant="primary"
						icon={CheckCircle2}
						onClick={() => act("confirm", `flag:${waitingFlag.key}`)}
						disabled={busy}
					>
						{t("run.flagDone")}
					</CharterButton>
				</Notice>
			)}
			{run.flags.length > 0 && (
				<Chips>
					{run.flags.map((f) => (
						<Chip key={f.key} tone={f.state === "on" ? "green" : f.state === "failed" ? "red" : "muted"}>
							{t("run.flag", { key: f.key, state: t(`flagStates.${f.state}`) })}
						</Chip>
					))}
				</Chips>
			)}
			{run.status === "blocked" && run.blocked && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					<p>
						{run.blocked.kind === "flag"
							? t("run.flagBlocked", { key: run.blocked.name, detail: run.blocked.detail })
							: t("run.blocked", {
									service: run.blocked.name,
									step: t(`steps.${run.blocked.step}`, { defaultValue: run.blocked.step }),
									detail: run.blocked.detail,
								})}
					</p>
					{failed && <StepOutput item={failed} />}
					<div className="mt-2 flex flex-wrap gap-2">
						<CharterButton variant="primary" icon={RotateCcw} onClick={() => act("retry")} disabled={busy}>
							{t("run.retry")}
						</CharterButton>
						{failed && (
							<CharterButton variant="danger" icon={Undo2} onClick={() => act("rollback", failed.service)} disabled={busy}>
								{t("run.rollback")}
							</CharterButton>
						)}
						<CharterButton variant="ghost" icon={Ban} onClick={() => act("abort")} disabled={busy}>
							{t("run.abort")}
						</CharterButton>
					</div>
					<p className="wp-meta mt-1">{t("run.blockedHint")}</p>
				</Notice>
			)}
			{run.journal && run.journal.length > 0 && (
				<details className="mt-2">
					<summary className="wp-kicker cursor-pointer">{t("run.journal")}</summary>
					<ul className="mt-1 space-y-0.5 font-mono text-xs">
						{run.journal.map((entry, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the journal only grows, in order
							<li key={index} className={entry.kind === "error" ? "text-destructive" : undefined}>
								{formatAppTime(entry.at)} {entry.service && `${entry.service} · `}
								{entry.text}
							</li>
						))}
					</ul>
				</details>
			)}
		</Panel>
	);
}

function ItemRow({
	item,
	disabled,
	onGo,
}: {
	readonly item: TrainItem;
	readonly disabled: boolean;
	readonly onGo: () => void;
}): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	return (
		<li className="flex flex-wrap items-center gap-2">
			<Chip tone={ITEM_TONES[item.status]}>{t(`itemStatuses.${item.status}`)}</Chip>
			<span className="wp-title text-sm">{item.service}</span>
			{item.version && <span className="font-mono text-xs">{item.version}</span>}
			{item.phase && <span className="wp-meta">{t(`steps.${item.phase}`, { defaultValue: item.phase })}</span>}
			{item.detail && item.status !== "failed" && <span className="wp-meta">{item.detail}</span>}
			{item.status === "waiting_confirmation" && (
				<CharterButton variant="primary" icon={Play} onClick={onGo} disabled={disabled}>
					{item.external ? t("run.externalReady") : t("run.deploy", { service: item.service })}
				</CharterButton>
			)}
		</li>
	);
}

function StepOutput({ item }: { readonly item: TrainItem }): React.ReactElement | null {
	const outcome = Object.values(item.steps).find((s) => s && s.status !== "passed");
	if (!outcome?.output) return null;
	return <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{outcome.output}</pre>;
}
