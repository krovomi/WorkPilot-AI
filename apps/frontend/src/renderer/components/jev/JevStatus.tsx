import { useAirgapStatus } from "../../hooks/useAirgapStatus";
import { useProjectStore } from "../../stores/project-store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { JevObservation } from "../../../shared/types/jev";
import { useJevStore } from "../../stores/jev-store";
import { useSettingsStore } from "../../stores/settings-store";
export function JevStatus({
	workflow,
	offline = false,
	observation,
	projectId,
}: {
	workflow: string;
	projectId?: string;
	offline?: boolean;
	observation?: JevObservation | null;
}) {
	const { t } = useTranslation("settings");
	const path = useProjectStore(
		(s) => s.projects.find((p) => p.id === projectId)?.path,
	);
	const policy = useAirgapStatus(path);
	const config = useSettingsStore((s) => s.settings.jev);
	const { status, refresh } = useJevStore();
	useEffect(() => {
		void refresh();
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);
	const mode = config?.workflows?.[workflow] ?? "inherit";
	const reason =
		offline || policy.airgapStrict
			? "offline"
			: mode === "bypass"
				? "workflow_bypass"
				: mode !== "enabled" && !config?.enabled
					? "disabled"
					: status === null
						? "unknown"
						: !status.configured
							? "missing_key"
							: projectId && !policy.loaded
								? "unknown"
								: "ready";
	const latest = observation?.evaluations.at(-1);
	return (
		<div className="rounded border p-3 text-xs space-y-1">
			<p>
				{t("jev.title")}: {t("jev.reasons." + reason)}
			</p>
			{latest && (
				<p>
					{t("jev.history")}:{" "}
					{latest.status === "evaluated"
						? t("jev.evaluated")
						: t("jev.reasons." + latest.reason, {
								defaultValue: t("jev.reasons.unavailable"),
							})}{" "}
					· {latest.revision.slice(0, 12)}
				</p>
			)}
			{latest?.status === "evaluated" &&
				Object.entries(latest.answers ?? {}).map(([name, answer]) => (
					<p key={name}>
						{t("jev.answers." + name)}: {answer.value}{" "}
						{answer.confidence !== undefined &&
							t("jev.confidence", {
								value: Math.round(answer.confidence * 100),
							})}
					</p>
				))}
		</div>
	);
}
