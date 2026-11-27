/**
 * The notice of what the server measures about the person (RGPD article
 * 13): what, for how long, who reads it, and where to see and download it.
 */

import { useTranslation } from "react-i18next";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button } from "../ui/components";
import { RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import type { UsageNotice } from "./types";

export function UsageNoticeModal({ notice, onClose }: { notice: UsageNotice | null; onClose: () => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const lines = notice ? [...notice.measured, ...(notice.page_activity ? ["pages"] : [])] : [];
	return (
		<Modal visible={notice !== null} transparent animationType="fade" onRequestClose={onClose}>
			<View style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
				<View style={[styles.card, { backgroundColor: theme.surface }]}>
					<ScrollView contentContainerStyle={{ gap: SPACE.sm }}>
						<Text accessibilityRole="header" style={[TYPE.heading, { color: theme.text }]}>
							{t("usageNotice.title")}
						</Text>
						<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("usageNotice.intro")}</Text>
						{lines.map((what) => (
							<Text key={what} style={[TYPE.small, { color: theme.text }]}>
								{t("usageNotice.bullet", { text: t(`usageNotice.measured.${what}`) })}
							</Text>
						))}
						<Text style={[TYPE.small, { color: theme.text }]}>{t("usageNotice.never")}</Text>
						{notice ? (
							<>
								<Text style={[TYPE.small, { color: theme.text }]}>
									{t("usageNotice.retention", { days: notice.usage_retention_days })}
								</Text>
								{notice.page_activity ? (
									<Text style={[TYPE.small, { color: theme.text }]}>
										{t("usageNotice.pageRetention", { days: notice.page_activity_retention_days })}
									</Text>
								) : null}
								<Text style={[TYPE.small, { color: theme.text }]}>
									{t("usageNotice.visibleTo", { roles: notice.visible_to.join(", ") })}
								</Text>
							</>
						) : null}
						<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("usageNotice.rights")}</Text>
					</ScrollView>
					<Button label={t("usageNotice.understood")} onPress={onClose} />
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	backdrop: { flex: 1, justifyContent: "center", padding: SPACE.lg },
	card: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md, maxHeight: "85%" },
});
