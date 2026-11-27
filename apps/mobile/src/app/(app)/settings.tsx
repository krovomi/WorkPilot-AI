import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MyPermissions } from "../../api/types";
import { visiblePages } from "../../admin/pages";
import { LockSection } from "../../auth/LockSection";
import { SessionSection } from "../../auth/SessionSection";
import { useSession } from "../../auth/session";
import { describeError } from "../../i18n";
import { Button, ErrorBanner, Section } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { Avatar, Chip, ListRow } from "../../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../../ui/theme";
import { ThemeSection } from "../../ui/ThemeSection";
import { orgRoleLabel } from "../../i18n/labels";

export default function Settings() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { serverUrl, permissions, switchOrg, signOut, can, user } = useSession();
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const choose = async (orgId: string) => {
		if (orgId === permissions?.org_id) return;
		setBusy(orgId);
		setError(null);
		try {
			await switchOrg(orgId);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(null);
		}
	};

	// Signed in, so read: the session sets the permissions with the signed-in status.
	const organizations = (permissions as MyPermissions).organizations;
	const administers = visiblePages(can).length > 0;
	const org = organizations.find((o) => o.id === permissions?.org_id);
	return (
		<ScrollView contentContainerStyle={styles.content}>
			<View style={[styles.profile, { backgroundColor: theme.surface }, elevation(theme)]}>
				<Avatar name={user?.display_name || user?.email || "?"} size={52} />
				<View style={{ flex: 1, gap: 2 }}>
					<Text style={[TYPE.heading, { color: theme.text }]} numberOfLines={1}>
						{user?.display_name}
					</Text>
					<Text style={[TYPE.small, { color: theme.textMuted }]} numberOfLines={1}>
						{user?.email}
					</Text>
					<View style={styles.server}>
						<Icon name="server" size={12} color={theme.textFaint} />
						<Text accessibilityLabel={t("settings.server")} style={[TYPE.caption, { color: theme.textFaint }]} numberOfLines={1} selectable>
							{serverUrl}
						</Text>
					</View>
				</View>
				{org ? <Chip label={org.name} icon="briefcase" /> : null}
			</View>
			<ThemeSection />
			<View style={{ gap: SPACE.sm }}>
				{administers ? (
					<ListRow icon="users" title={t("admin.title")} subtitle={t("admin.summary")} onPress={() => router.push("/admin")} />
				) : null}
				<ListRow
					icon="bell"
					title={t("needsYou.title")}
					subtitle={t("needsYou.summary")}
					onPress={() => router.push("/needs-you")}
				/>
				{can("lab.read") ? (
					<ListRow
						icon="film"
						title={t("replays.title")}
						subtitle={t("replays.summary")}
						onPress={() => router.push("/replays")}
					/>
				) : null}
				<ListRow icon="key" title={t("tokens.title")} subtitle={t("tokens.summary")} onPress={() => router.push("/tokens")} />
			</View>
			<LockSection />
			<SessionSection />
			{organizations.length > 0 ? (
				<Section title={t("settings.organization")} icon="briefcase">
					{organizations.map((org) => {
						const selected = org.id === permissions?.org_id;
						return (
							<Pressable
								key={org.id}
								accessibilityRole="radio"
								accessibilityState={{ selected, busy: busy === org.id }}
								disabled={!!busy}
								onPress={() => void choose(org.id)}
								style={[
									styles.org,
									{
										borderColor: selected ? theme.accent : theme.border,
										backgroundColor: selected ? theme.accentSoft : "transparent",
									},
								]}
							>
								<View style={{ flex: 1 }}>
									<Text style={{ color: theme.text, fontWeight: "600" }}>{org.name}</Text>
									{org.my_role ? <Text style={{ color: theme.textMuted }}>{orgRoleLabel(org.my_role)}</Text> : null}
								</View>
								{selected ? <Icon name="check-circle" size={18} color={theme.accent} /> : null}
							</Pressable>
						);
					})}
				</Section>
			) : null}
			<ErrorBanner message={error} />
			<Button label={t("settings.signOut")} icon="log-out" variant="danger" onPress={() => void signOut()} />
			<Text style={{ color: theme.textFaint, textAlign: "center" }}>
				{t("settings.version", { version: Constants.expoConfig?.version ?? "?" })}
			</Text>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	profile: { flexDirection: "row", alignItems: "center", gap: SPACE.md, borderRadius: RADIUS.lg, padding: SPACE.lg },
	server: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
	org: {
		flexDirection: "row",
		alignItems: "center",
		borderWidth: 1,
		borderRadius: RADIUS.md,
		padding: SPACE.md,
	},
});
