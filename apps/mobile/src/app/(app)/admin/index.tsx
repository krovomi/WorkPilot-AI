import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { visiblePages } from "../../../admin/pages";
import { useSession } from "../../../auth/session";
import { RADIUS, SPACE, useTheme } from "../../../ui/theme";

export default function Administration() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can, permissions } = useSession();
	const org = permissions?.organizations.find((o) => o.id === permissions.org_id);
	return (
		<ScrollView contentContainerStyle={styles.content}>
			{org ? <Text style={{ color: theme.textMuted }}>{t("admin.of", { org: org.name })}</Text> : null}
			{visiblePages(can).map(({ page }) => (
				<Pressable
					key={page}
					accessibilityRole="link"
					onPress={() => router.push(`/admin/${page}`)}
					style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }}>{t(`admin.${page}.title`)}</Text>
					<Text style={{ color: theme.textMuted }}>{t(`admin.${page}.summary`)}</Text>
				</Pressable>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
