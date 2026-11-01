/** A feature's job: generate (or regenerate), its progress while it runs, its failure. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner } from "../ui/components";
import { RADIUS, SPACE, useTheme } from "../ui/theme";
import type { FeatureJob } from "./types";

export function JobBar({
	job,
	active,
	lastLine,
	hasContent,
	onStart,
	onCancel,
}: {
	job: FeatureJob | null;
	active: boolean;
	lastLine: string | null;
	hasContent: boolean;
	onStart: () => Promise<void>;
	onCancel: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const { can } = useSession();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const act = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<View style={{ gap: SPACE.sm }}>
			<ErrorBanner message={error} />
			{active ? (
				<View style={[styles.running, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
					<Text style={{ color: theme.text, fontWeight: "600" }}>{t("features.jobRunning")}</Text>
					{lastLine ? (
						<Text style={{ color: theme.textMuted, fontSize: 12 }} numberOfLines={2}>
							{lastLine}
						</Text>
					) : null}
					{can("agent.cancel") ? (
						<Button label={t("actions.stop")} variant="danger" busy={busy} onPress={() => void act(onCancel)} />
					) : null}
				</View>
			) : (
				<>
					{job?.status === "failed" ? (
						<ErrorBanner message={t("features.jobFailed", { error: job.error ?? "" })} />
					) : null}
					{can("agent.execute") ? (
						<Button
							label={hasContent ? t("features.regenerate") : t("features.generate")}
							variant={hasContent ? "secondary" : "primary"}
							busy={busy}
							onPress={() => void act(onStart)}
						/>
					) : null}
				</>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	running: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
