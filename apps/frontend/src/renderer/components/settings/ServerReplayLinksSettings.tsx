/**
 * The person's own team links to a replay (server mode, #347): every link
 * they made, on every project of the server they still reach, with what it
 * is, when it ends, how often it was opened, and Revoke.
 *
 * The share dialog lists one project's links; this lists them all, so that
 * a link sent to the wrong place is ended in one place. The server checks
 * again that the person is its author (`shared_features/replay_shares.py`).
 */

import { Link2, Loader2, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import { useReplayUsageStore } from "../../stores/replay-usage-store";
import { Notice } from "../charter";
import { SettingsSection } from "./SettingsSection";

export function ServerReplayLinksSettings() {
	const { t } = useTranslation(["settings", "replay"]);
	const { mine, loading, error, loadMine, revokeMine } = useReplayUsageStore(
		useShallow((s) => ({
			mine: s.mine,
			loading: s.mineLoading,
			error: s.mineError,
			loadMine: s.loadMine,
			revokeMine: s.revokeMine,
		})),
	);

	useEffect(() => {
		void loadMine();
	}, [loadMine]);

	return (
		<SettingsSection
			title={t("settings:serverReplayLinks.title")}
			description={t("settings:serverReplayLinks.description")}
		>
			{error && (
				<Notice tone="red" role="alert">
					{t(error.key, error.values)}
				</Notice>
			)}
			<div className="flex justify-end">
				<Button variant="outline" size="sm" disabled={loading} onClick={() => loadMine()}>
					{loading ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<RefreshCw className="mr-2 h-4 w-4" />
					)}
					{t("settings:serverReplayLinks.refresh")}
				</Button>
			</div>
			{mine && mine.length === 0 && (
				<p className="text-sm text-muted-foreground">{t("settings:serverReplayLinks.empty")}</p>
			)}
			{mine && mine.length > 0 && (
				<ul className="space-y-2">
					{mine.map((share) => (
						<li
							key={share.id}
							className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
						>
							<div className="min-w-0 flex-1 space-y-1">
								<p className="flex items-center gap-2 text-sm font-medium">
									<Link2 className="h-4 w-4 shrink-0" />
									<span className="break-words">{share.title}</span>
								</p>
								<p className="text-xs text-muted-foreground">
									{t("settings:serverReplayLinks.project", { project: share.projectName })}
								</p>
								<p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
									<span>{t(`replay:share.team.state.${share.state}`)}</span>
									<span>
										{t("replay:share.team.expires", {
											date: formatAppDateTime(share.expiresAt),
										})}
									</span>
									<span>{t("replay:share.team.opened", { count: share.openCount })}</span>
								</p>
							</div>
							{share.canRevoke && share.state === "active" && (
								<Button variant="outline" size="sm" onClick={() => revokeMine(share)}>
									{t("replay:share.team.revoke")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</SettingsSection>
	);
}
