import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { byDomain, slugify, useAdminApi } from "../../../../admin/api";
import { useAction } from "../../../../admin/useAction";
import { useSession } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../../ui/components";
import { SPACE, useTheme } from "../../../../ui/theme";

/**
 * A role and its permissions. A built-in role is read only; a custom one of
 * the organization is edited here, or created when the route is `new`.
 */
export default function RoleScreen() {
	const { roleId } = useLocalSearchParams<{ roleId: string }>();
	const creating = roleId === "new";
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const admin = useAdminApi();
	const { can } = useSession();
	const load = useCallback(async () => {
		const [roles, permissions] = await Promise.all([admin.roles(), admin.permissions()]);
		return { role: roles.find((r) => r.id === roleId) ?? null, permissions };
	}, [admin, roleId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const role = data?.role ?? null;
	const editable = can("org.role.write") && (creating || (!!role && !role.is_system && !!role.org_id));
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [granted, setGranted] = useState<Set<string>>(new Set());
	const action = useAction();

	useEffect(() => {
		if (!role) return;
		setName(role.name);
		setDescription(role.description);
		setGranted(new Set(role.permissions));
	}, [role]);

	if (loading && !data) return <Loading />;
	if (!creating && !role) return <ErrorBanner message={error ? describeError(error) : t("admin.roles.gone")} />;

	const toggle = (key: string, on: boolean) =>
		setGranted((current) => {
			const next = new Set(current);
			if (on) next.add(key);
			else next.delete(key);
			return next;
		});
	const save = async () => {
		const permissions = [...granted].sort();
		const ok = await action.run("save", () =>
			creating
				? admin.createRole({ slug: slugify(name), name: name.trim(), description: description.trim(), permissions })
				: admin.updateRole(roleId, { name: name.trim(), description: description.trim(), permissions }),
		);
		if (ok) {
			if (creating) router.back();
			else await reload();
		}
	};
	const remove = () =>
		Alert.alert(t("admin.roles.deleteTitle", { name: role?.name ?? "" }), t("admin.roles.deleteBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("admin.roles.delete"),
				style: "destructive",
				onPress: async () => {
					if (await action.run("delete", () => admin.deleteRole(roleId))) router.back();
				},
			},
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ title: creating ? t("admin.roles.new") : (role?.name ?? "") }} />
			<ErrorBanner message={action.error ?? (error ? describeError(error) : null)} />
			{editable ? (
				<>
					<Field label={t("admin.roles.name")} value={name} onChangeText={setName} maxLength={120} />
					{creating && name.trim() ? (
						<Text style={{ color: theme.textFaint, fontSize: 12 }}>{t("admin.roles.slug", { slug: slugify(name) })}</Text>
					) : null}
					<Field
						label={t("admin.roles.description")}
						value={description}
						onChangeText={setDescription}
						multiline
						maxLength={2000}
					/>
				</>
			) : (
				<>
					{role?.description ? <Text style={{ color: theme.textMuted }}>{role.description}</Text> : null}
					{role?.is_system ? <Text style={{ color: theme.textFaint }}>{t("admin.roles.readOnly")}</Text> : null}
				</>
			)}
			{byDomain(data?.permissions ?? []).map(({ domain, permissions }) => (
				<Section key={domain} title={domain}>
					{permissions.map((p) => (
						<View key={p.key} style={styles.permission}>
							<Text style={{ color: theme.text, flex: 1 }}>
								{p.key}
								{p.privileged ? <Text style={{ color: theme.danger }}>{` · ${t("admin.roles.privileged")}`}</Text> : null}
							</Text>
							<Switch
								accessibilityLabel={p.key}
								value={granted.has(p.key)}
								disabled={!editable}
								onValueChange={(on) => toggle(p.key, on)}
							/>
						</View>
					))}
				</Section>
			))}
			{editable ? (
				<Button
					label={creating ? t("admin.roles.create") : t("admin.roles.save")}
					busy={action.busy === "save"}
					disabled={slugify(name).length < 2}
					onPress={() => void save()}
				/>
			) : null}
			{editable && !creating ? (
				<Button label={t("admin.roles.delete")} variant="danger" busy={action.busy === "delete"} onPress={remove} />
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	permission: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
});
