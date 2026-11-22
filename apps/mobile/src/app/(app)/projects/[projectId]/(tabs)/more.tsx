import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet } from "react-native";
import { useProjectId } from "../../../../../project/ProjectId";
import { useSession } from "../../../../../auth/session";
import { morePages, PAGE_ICONS } from "../../../../../project/pages";
import { EmptyState, ListRow } from "../../../../../ui/kit";
import { SPACE } from "../../../../../ui/theme";

/** The project's other pages, one row each, with what the page is for. */
export default function More() {
	const projectId = useProjectId();
	const { t } = useTranslation();
	const router = useRouter();
	const { can } = useSession();
	const pages = morePages(can);
	return (
		<ScrollView contentContainerStyle={styles.content}>
			{pages.length === 0 ? <EmptyState icon="lock" title={t("nav.moreEmpty")} /> : null}
			{pages.map((page) => (
				<ListRow
					key={page}
					icon={PAGE_ICONS[page]}
					title={t(`nav.pages.${page}.title`)}
					subtitle={t(`nav.pages.${page}.hint`)}
					onPress={() => router.push({ pathname: `/projects/[projectId]/${page}`, params: { projectId } })}
				/>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
});
