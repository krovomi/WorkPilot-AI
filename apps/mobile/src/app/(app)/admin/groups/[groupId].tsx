import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { orgRoles, useAdminApi } from "../../../../admin/api";
import { Choice } from "../../../../admin/Choice";
import { PROJECT_ROLES, type ProjectRole } from "../../../../admin/types";
import { useAction } from "../../../../admin/useAction";
import { useApi, useSession } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

/** The server clears a group's role on an empty slug (null leaves it as it is). */
const NO_ROLE = "";

/** A group: its members, the projects it reaches and with which role, and the org role it gives. */
export default function GroupScreen() {
	const { groupId } = useLocalSearchParams<{ groupId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const admin = useAdminApi();
	const api = useApi();
	const { can } = useSession();
	const canWrite = can("org.member.write");
	const canProjects = can("project.member.write");
	const load = useCallback(async () => {
		const [groups, members, roles, projects] = await Promise.all([
			admin.groups(),
			admin.members(),
			can("org.role.read") ? admin.roles().catch(() => []) : Promise.resolve([]),
			api.projects(),
		]);
		return { group: groups.find((g) => g.id === groupId) ?? null, members, roles: orgRoles(roles), projects };
	}, [admin, api, can, groupId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [adding, setAdding] = useState<"member" | "project" | null>(null);
	const [projectRole, setProjectRole] = useState<ProjectRole>("member");
	const action = useAction();

	if (loading && !data) return <Loading />;
	const group = data?.group;
	if (!group) return <ErrorBanner message={error ? describeError(error) : t("admin.groups.gone")} />;
	const act = async (key: string, call: () => Promise<unknown>) => {
		if (await action.run(key, call)) {
			setAdding(null);
			await reload();
		}
	};
	const remove = () =>
		Alert.alert(t("admin.groups.deleteTitle", { name: group.name }), t("admin.groups.deleteBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("admin.groups.delete"),
				style: "destructive",
				onPress: async () => {
					if (await action.run("delete", () => admin.deleteGroup(group.id))) router.back();
				},
			},
		]);
	const inGroup = new Set(group.members.map((m) => m.user_id));
	const reached = new Set(group.projects.map((p) => p.project_id));

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ title: group.name }} />
			<ErrorBanner message={action.error ?? (error ? describeError(error) : null)} />
			{group.description ? <Text style={{ color: theme.textMuted }}>{group.description}</Text> : null}

			{data.roles.length ? (
				<Section title={t("admin.groups.orgRole")}>
					<Choice
						options={[
							{ value: NO_ROLE, label: t("admin.groups.noRole") },
							...data.roles.map((r) => ({ value: r.slug, label: r.name })),
						]}
						selected={group.role_slug ?? NO_ROLE}
						disabled={!canWrite || !!action.busy}
						onSelect={(slug) =>
							void act("role", () => admin.updateGroup(group.id, { role_slug: slug }))
						}
					/>
				</Section>
			) : null}

			<Section title={t("admin.groups.memberCount", { count: group.members.length })}>
				{group.members.map((m) => (
					<View key={m.user_id} style={[styles.row, { borderColor: theme.border }]}>
						<View style={{ flex: 1 }}>
							<Text style={{ color: theme.text }}>{m.display_name}</Text>
							<Text style={{ color: theme.textFaint, fontSize: 12 }}>{m.email}</Text>
						</View>
						{canWrite ? (
							<Button
								label={t("admin.remove")}
								variant="secondary"
								busy={action.busy === `m:${m.user_id}`}
								onPress={() => void act(`m:${m.user_id}`, () => admin.removeGroupMember(group.id, m.user_id))}
							/>
						) : null}
					</View>
				))}
				{canWrite && adding === "member" ? (
					<Choice
						options={data.members
							.filter((m) => !inGroup.has(m.user_id))
							.map((m) => ({ value: m.user_id, label: m.display_name, detail: m.email }))}
						selected={null}
						disabled={!!action.busy}
						onSelect={(userId) => void act("add-member", () => admin.addGroupMember(group.id, userId))}
					/>
				) : canWrite ? (
					<Button label={t("admin.groups.addMember")} variant="secondary" onPress={() => setAdding("member")} />
				) : null}
			</Section>

			<Section title={t("admin.groups.projectCount", { count: group.projects.length })}>
				{group.projects.map((p) => (
					<View key={p.project_id} style={[styles.row, { borderColor: theme.border }]}>
						<View style={{ flex: 1 }}>
							<Text style={{ color: theme.text }}>{p.name}</Text>
							<Text style={{ color: theme.textFaint, fontSize: 12 }}>{t(`admin.projectRole.${p.role}`, { defaultValue: p.role })}</Text>
						</View>
						{canProjects ? (
							<Button
								label={t("admin.remove")}
								variant="secondary"
								busy={action.busy === `p:${p.project_id}`}
								onPress={() => void act(`p:${p.project_id}`, () => admin.removeGroupProject(group.id, p.project_id))}
							/>
						) : null}
					</View>
				))}
				{canProjects && adding === "project" ? (
					<>
						<Choice
							options={PROJECT_ROLES.map((r) => ({ value: r, label: t(`admin.projectRole.${r}`) }))}
							selected={projectRole}
							onSelect={(r) => setProjectRole(r as ProjectRole)}
						/>
						<Choice
							options={data.projects.filter((p) => !reached.has(p.id)).map((p) => ({ value: p.id, label: p.name }))}
							selected={null}
							disabled={!!action.busy}
							onSelect={(projectId) =>
								void act("add-project", () => admin.setGroupProject(group.id, projectId, projectRole))
							}
						/>
					</>
				) : canProjects ? (
					<Button label={t("admin.groups.addProject")} variant="secondary" onPress={() => setAdding("project")} />
				) : null}
			</Section>

			{canWrite ? (
				<Button label={t("admin.groups.delete")} variant="danger" busy={action.busy === "delete"} onPress={remove} />
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		borderTopWidth: StyleSheet.hairlineWidth,
		paddingTop: SPACE.sm,
		borderRadius: RADIUS.sm,
	},
});
