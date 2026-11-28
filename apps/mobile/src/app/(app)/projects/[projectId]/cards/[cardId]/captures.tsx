/**
 * A card's captures, screen by screen, before and after, as its pull request
 * shows them: published copies only, with fakes in place of personal data
 * (`shared_board/captures.py`). When the team reviews captures first, a
 * reviewer publishes or withdraws them here; the server then puts the images
 * in the pull request, or takes them out, as a `captures` run.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi, useSession } from "../../../../../../auth/session";
import {
	canAnswerReview,
	replacedKinds,
	screenName,
	sideStatusKey,
	stateKey,
	syncReasonKey,
} from "../../../../../../captures/describe";
import type { CaptureItem, CaptureSide, CaptureSideName } from "../../../../../../captures/types";
import { useLoad } from "../../../../../../hooks/useLoad";
import { describeError } from "../../../../../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../../../../../ui/components";
import { formatDate } from "../../../../../../ui/format";
import { Chip, EmptyState } from "../../../../../../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../../../../../../ui/theme";

/** The rights a review's answer needs, then the run that updates the pull request. */
export const PUBLISH_PERMISSIONS = ["review.approve"] as const;
export const SYNC_PERMISSIONS = ["agent.execute", "vcs.pr.create"] as const;

export default function CardCapturesScreen() {
	const { projectId, cardId, specId } = useLocalSearchParams<{ projectId: string; cardId: string; specId?: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const load = useCallback(() => api.captures(projectId, cardId), [api, projectId, cardId]);
	const { data: captures, error, loading, refreshing, reload, refresh } = useLoad(load);
	const [busy, setBusy] = useState<"publish" | "withdraw" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	if (loading && !captures) return <Loading />;

	const answer = async (verb: "publish" | "withdraw") => {
		setBusy(verb);
		setActionError(null);
		setNotice(null);
		try {
			await (verb === "publish" ? api.publishCaptures(projectId, cardId) : api.withdrawCaptures(projectId, cardId));
			await refresh();
			// The pull request is updated by a run, with the person's forge token.
			if (specId && SYNC_PERMISSIONS.every(can)) {
				await api.startRun(projectId, specId, "captures");
				setNotice(t("captures.syncStarted"));
			} else {
				setNotice(t("captures.syncLater"));
			}
		} catch (err) {
			setActionError(describeError(err));
		} finally {
			setBusy(null);
		}
	};

	const sync = captures?.sync;
	const reviewing = !!captures && canAnswerReview(captures) && PUBLISH_PERMISSIONS.every(can);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ headerTitle: t("captures.screenTitle", { id: cardId.split("-")[0] }) }} />
			<ErrorBanner error={error} />
			{!captures || captures.items.length === 0 ? (
				<EmptyState icon="image" title={t(captures ? stateKey(captures) : "captures.state_notNeeded")} />
			) : (
				<>
					<Section title={t("captures.prTitle")} icon="git-pull-request">
						<Text style={{ color: theme.text }}>{t(stateKey(captures))}</Text>
						{sync?.reason ? <Text style={{ color: theme.danger }}>{t(syncReasonKey(sync.reason))}</Text> : null}
						{sync?.syncedAt ? (
							<Text style={{ color: theme.textFaint }}>
								{t("captures.syncedAt", { date: formatDate(sync.syncedAt, i18n.language) })}
							</Text>
						) : null}
						<Text style={{ color: theme.textMuted }}>
							{captures.protect === false ? t("captures.unprotected") : t("captures.fakesNote")}
						</Text>
						{captures.withheld > 0 ? (
							<Text style={{ color: theme.warning }}>{t("captures.withheldNote", { count: captures.withheld })}</Text>
						) : null}
						{sync?.prUrl.startsWith("https://") ? (
							<Button
								label={t("captures.openPr")}
								icon="external-link"
								variant="ghost"
								onPress={() => void Linking.openURL(sync.prUrl)}
							/>
						) : null}
						{reviewing ? (
							<View style={styles.actions}>
								{captures.approved ? (
									<Button
										label={t("captures.withdraw")}
										icon="eye-off"
										variant="secondary"
										busy={busy === "withdraw"}
										disabled={!!busy}
										onPress={() => void answer("withdraw")}
									/>
								) : (
									<Button
										label={t("captures.publish")}
										icon="upload-cloud"
										busy={busy === "publish"}
										disabled={!!busy}
										onPress={() => void answer("publish")}
									/>
								)}
							</View>
						) : null}
						{notice ? <Text style={{ color: theme.success }}>{notice}</Text> : null}
						<ErrorBanner message={actionError} />
					</Section>
					{captures.items.map((item, index) => (
						<Screen key={item.key || index} item={item} index={index} projectId={projectId} cardId={cardId} />
					))}
				</>
			)}
		</ScrollView>
	);
}

function Screen({
	item,
	index,
	projectId,
	cardId,
}: {
	item: CaptureItem;
	index: number;
	projectId: string;
	cardId: string;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const kinds = replacedKinds(item);
	return (
		<Section title={screenName(item)} icon={item.platform === "web" ? "globe" : "smartphone"}>
			<View style={styles.chips}>
				{item.platform ? <Chip label={item.platform} /> : null}
				{item.variant === "mobile" ? <Chip label={t("captures.phoneView")} icon="smartphone" /> : null}
				{item.locale ? <Chip label={item.locale} /> : null}
				{!item.publishable ? <Chip label={t("captures.keptOnTask")} icon="lock" color={theme.warning} /> : null}
			</View>
			{kinds.length ? (
				<Text style={{ color: theme.textMuted }}>
					{t("captures.kinds", {
						kinds: kinds
							.map((kind) => (i18n.exists(`captures.kind_${kind}`) ? t(`captures.kind_${kind}`) : kind))
							.join(", "),
					})}
				</Text>
			) : null}
			<Side name="before" side={item.before} index={index} projectId={projectId} cardId={cardId} />
			<Side name="after" side={item.after} index={index} projectId={projectId} cardId={cardId} />
		</Section>
	);
}

function Side({
	name,
	side,
	index,
	projectId,
	cardId,
}: {
	name: CaptureSideName;
	side: CaptureSide | null;
	index: number;
	projectId: string;
	cardId: string;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [uri, setUri] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [ratio, setRatio] = useState(16 / 10);
	const available = !!side?.available;

	useEffect(() => {
		if (!available) return;
		// Asked for when the screen shows it, never kept once the screen goes.
		api
			.captureImage(projectId, cardId, index, name)
			.then((image) => setUri(`data:${image.mimeType};base64,${image.data}`))
			.catch(() => setFailed(true));
	}, [api, projectId, cardId, index, name, available]);

	const label = t(`captures.${name}`);
	return (
		<View style={styles.side}>
			<Text style={[TYPE.small, { color: theme.textMuted }]}>
				{label}
				{side ? ` · ${t(sideStatusKey(side))}` : ""}
			</Text>
			{!side ? (
				<Text style={{ color: theme.textFaint }}>{t(name === "before" ? "captures.noBefore" : "captures.noAfter")}</Text>
			) : !available ? (
				<Text style={{ color: theme.textFaint }}>{t("captures.notShown")}</Text>
			) : failed ? (
				<Text style={{ color: theme.danger }}>{t("captures.imageFailed")}</Text>
			) : uri ? (
				<Image
					accessibilityLabel={t("captures.imageLabel", { side: label })}
					source={{ uri }}
					resizeMode="contain"
					onLoad={(event) => {
						const { width, height } = event.nativeEvent.source;
						if (width > 0 && height > 0) setRatio(width / height);
					}}
					style={[styles.image, { aspectRatio: ratio, borderColor: theme.border, backgroundColor: theme.surface }]}
				/>
			) : (
				<View style={[styles.image, styles.placeholder, { aspectRatio: ratio, borderColor: theme.border }]} />
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	actions: { gap: SPACE.sm },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
	side: { gap: SPACE.xs },
	image: { width: "100%", borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth },
	placeholder: { opacity: 0.4 },
});
