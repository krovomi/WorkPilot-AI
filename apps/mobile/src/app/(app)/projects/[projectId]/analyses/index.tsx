import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { ANALYSES } from "../../../../../insights/types";
import { RADIUS, SPACE, useTheme } from "../../../../../ui/theme";

export default function Analyses() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	return (
		<ScrollView contentContainerStyle={styles.content}>
			<Text style={{ color: theme.textMuted }}>{t("analyses.intro")}</Text>
			{ANALYSES.map((kind) => (
				<Pressable
					key={kind}
					accessibilityRole="button"
					onPress={() => router.push({ pathname: "/projects/[projectId]/analyses/[kind]", params: { projectId, kind } })}
					style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }}>{t(`analyses.kinds.${kind}.title`)}</Text>
					<Text style={{ color: theme.textMuted, fontSize: 13 }}>{t(`analyses.kinds.${kind}.body`)}</Text>
				</Pressable>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
