/**
 * The person's AI accounts on the server: several keys per provider (their
 * own, their employer's, a client's), one the default, whose key the runs
 * they start use instead of the server's. The phone sends a key once and
 * never reads it back: the server says only that it is saved, and when.
 * Without `settings.account.write` the list is read-only (the server
 * refuses the changes anyway).
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Choice } from "../../admin/Choice";
import { type AiAccount, MAX_KEY_LENGTH, MAX_NAME_LENGTH, providersWithAccounts } from "../../ai-accounts/types";
import { useApi, useSession } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../ui/components";
import { formatDate } from "../../ui/format";
import { RADIUS, SPACE, TYPE, useTheme } from "../../ui/theme";

/** The choice that leaves a provider on the server's own credentials. */
const SERVER = "server";

function useProviderName(): (provider: string) => string {
	const { t } = useTranslation();
	return (provider) => t(`aiAccounts.providers.${provider}`, { defaultValue: provider });
}

/** Runs one change at a time and keeps its error. */
function useChange(onDone: () => Promise<void>) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async (action: () => Promise<unknown>): Promise<boolean> => {
		setBusy(true);
		setError(null);
		try {
			await action();
			await onDone();
			return true;
		} catch (err) {
			setError(describeError(err));
			return false;
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, run };
}

export default function AiAccounts() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const canWrite = can("settings.account.write");
	const load = useCallback(() => api.aiAccounts(), [api]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	if (loading && !data) return <Loading />;
	const providers = data ? providersWithAccounts(data) : [];
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={{ color: theme.textMuted, lineHeight: 21 }}>{t("aiAccounts.intro")}</Text>
			<ErrorBanner error={error} />
			{data && providers.length === 0 ? (
				<Text style={{ color: theme.textFaint }}>{t("aiAccounts.empty")}</Text>
			) : null}
			{data
				? providers.map((provider) => (
						<ProviderSection
							key={provider}
							provider={provider}
							accounts={data.accounts.filter((a) => a.provider === provider)}
							selected={data.defaults[provider] ?? SERVER}
							canWrite={canWrite}
							onChanged={reload}
						/>
					))
				: null}
			{data && canWrite ? <AddAccount providers={data.providers} onAdded={reload} /> : null}
			{data && !canWrite ? <Text style={{ color: theme.textFaint }}>{t("aiAccounts.readOnly")}</Text> : null}
		</ScrollView>
	);
}

function ProviderSection({
	provider,
	accounts,
	selected,
	canWrite,
	onChanged,
}: {
	provider: string;
	accounts: AiAccount[];
	selected: string;
	canWrite: boolean;
	onChanged: () => Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const providerName = useProviderName();
	const api = useApi();
	const { busy, error, run } = useChange(onChanged);
	const options = [
		...accounts.map((a) => ({
			value: a.id,
			label: a.name,
			detail: t("aiAccounts.keySaved", { date: formatDate(a.key_set_at, i18n.language) }),
		})),
		{ value: SERVER, label: t("aiAccounts.serverAccount"), detail: t("aiAccounts.serverAccountDetail") },
	];
	const choose = (value: string) => {
		if (value === selected) return;
		void run(() => api.setDefaultAiAccount(provider, value === SERVER ? null : value));
	};
	return (
		<Section title={providerName(provider)} icon="cpu">
			<ErrorBanner message={error} />
			<Choice options={options} selected={selected} onSelect={choose} disabled={!canWrite || busy} />
			{canWrite ? accounts.map((a) => <AccountActions key={a.id} account={a} onChanged={onChanged} />) : null}
		</Section>
	);
}

function AccountActions({ account, onChanged }: { account: AiAccount; onChanged: () => Promise<void> }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { busy, error, run } = useChange(onChanged);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(account.name);
	const [key, setKey] = useState("");

	const save = async () => {
		const change: { name?: string; key?: string } = {};
		if (name.trim() && name.trim() !== account.name) change.name = name.trim();
		if (key.trim()) change.key = key.trim();
		if (!change.name && !change.key) {
			setEditing(false);
			return;
		}
		if (await run(() => api.updateAiAccount(account.id, change))) {
			setKey("");
			setEditing(false);
		}
	};

	const remove = () =>
		Alert.alert(t("aiAccounts.removeTitle", { name: account.name }), t("aiAccounts.removeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("aiAccounts.remove"),
				style: "destructive",
				onPress: () => void run(() => api.deleteAiAccount(account.id)),
			},
		]);

	return (
		<View style={[styles.row, { borderColor: theme.border }]}>
			<Text style={[TYPE.small, { color: theme.text, fontWeight: "600" }]}>{account.name}</Text>
			<ErrorBanner message={error} />
			{editing ? (
				<>
					<Field
						label={t("aiAccounts.name")}
						value={name}
						onChangeText={setName}
						maxLength={MAX_NAME_LENGTH}
					/>
					<Field
						label={t("aiAccounts.newKey")}
						value={key}
						onChangeText={setKey}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={MAX_KEY_LENGTH}
					/>
					<View style={styles.line}>
						<View style={{ flex: 1 }}>
							<Button label={t("common.cancel")} variant="secondary" onPress={() => setEditing(false)} />
						</View>
						<View style={{ flex: 1 }}>
							<Button label={t("aiAccounts.save")} busy={busy} onPress={() => void save()} />
						</View>
					</View>
				</>
			) : (
				<View style={styles.line}>
					<View style={{ flex: 1 }}>
						<Button
							label={t("aiAccounts.editShort")}
							accessibilityLabel={t("aiAccounts.edit", { name: account.name })}
							icon="edit-2"
							variant="secondary"
							onPress={() => setEditing(true)}
						/>
					</View>
					<View style={{ flex: 1 }}>
						<Button
							label={t("aiAccounts.remove")}
							accessibilityLabel={t("aiAccounts.removeOne", { name: account.name })}
							icon="trash-2"
							variant="danger"
							busy={busy}
							onPress={remove}
						/>
					</View>
				</View>
			)}
		</View>
	);
}

function AddAccount({ providers, onAdded }: { providers: string[]; onAdded: () => Promise<void> }) {
	const { t } = useTranslation();
	const api = useApi();
	const providerName = useProviderName();
	const { busy, error, run } = useChange(onAdded);
	const [provider, setProvider] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [key, setKey] = useState("");

	const add = async (chosen: string) => {
		if (await run(() => api.addAiAccount(chosen, name.trim(), key.trim()))) {
			setProvider(null);
			setName("");
			setKey("");
		}
	};

	return (
		<Section title={t("aiAccounts.addTitle")} icon="plus">
			<ErrorBanner message={error} />
			<Choice
				options={providers.map((p) => ({ value: p, label: providerName(p) }))}
				selected={provider}
				onSelect={setProvider}
				disabled={busy}
			/>
			{provider ? (
				<>
					<Field
						label={t("aiAccounts.name")}
						placeholder={t("aiAccounts.namePlaceholder")}
						value={name}
						onChangeText={setName}
						maxLength={MAX_NAME_LENGTH}
					/>
					<Field
						label={provider === "claude" ? t("aiAccounts.claudeToken") : t("aiAccounts.key")}
						value={key}
						onChangeText={setKey}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={MAX_KEY_LENGTH}
					/>
					<Button
						label={t("aiAccounts.add")}
						busy={busy}
						disabled={!name.trim() || !key.trim()}
						onPress={() => void add(provider)}
					/>
				</>
			) : null}
		</Section>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	row: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: SPACE.sm, borderRadius: RADIUS.sm },
	line: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
});
