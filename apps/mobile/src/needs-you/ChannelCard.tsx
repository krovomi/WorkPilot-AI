/**
 * One "needs you" channel: whether it is set, the switch that pauses it, its
 * form, a test and its removal. A secret is typed blind and never read back:
 * left empty, the server keeps the one it stored.
 */

import * as Crypto from "expo-crypto";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, Switch, Text, View } from "react-native";
import { useApi } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field } from "../ui/components";
import { Chip } from "../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import { CHANNEL_FIELDS, type Channel, type ChannelSettings, type ChannelState, MASK } from "./types";

/** What the card may do: `write` stores and tests (`agent.execute`), `store` says the server can keep a secret. */
export interface ChannelRights {
	write: boolean;
	store: boolean;
	/** The operator turned sending on: a test can leave the server. */
	send: boolean;
}

type Values = Partial<Record<keyof ChannelSettings, string>>;

/** The fields as the form opens: what is not secret, as stored; secrets empty. */
function initialValues(channel: Channel, state: ChannelState): Values {
	const values: Values = {};
	for (const field of CHANNEL_FIELDS[channel]) {
		const stored = state.configured && !field.secret ? state[field.key as "server" | "chat_id"] : undefined;
		values[field.key] = typeof stored === "string" ? stored : "";
	}
	return values;
}

/** What is stored of the fields that are not secret, sent again so a switch keeps them. */
function keptSettings(channel: Channel, state: ChannelState): Omit<ChannelSettings, "enabled"> {
	return Object.fromEntries(Object.entries(initialValues(channel, state)).filter(([, value]) => value));
}

export function ChannelCard({
	channel,
	state,
	rights,
	onChanged,
}: {
	channel: Channel;
	state: ChannelState;
	rights: ChannelRights;
	onChanged: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [editing, setEditing] = useState(false);
	const [values, setValues] = useState<Values>(() => initialValues(channel, state));
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const name = t(`needsYou.channels.${channel}`);
	const readable = state.configured && state.readable;

	const run = async (what: string, action: () => Promise<string | null | undefined>) => {
		setBusy(what);
		setError(null);
		setNote(null);
		try {
			setNote((await action()) ?? null);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(null);
		}
	};

	/** A secret field already stored: empty keeps it. */
	const isSet = (key: keyof ChannelSettings) => readable && state[key as "topic"] === MASK;

	const missing = CHANNEL_FIELDS[channel].some(
		(field) => !field.optional && !values[field.key]?.trim() && !(field.secret && isSet(field.key)),
	);

	const save = () =>
		run("save", async () => {
			const settings: ChannelSettings = { enabled: state.configured ? state.enabled : true };
			for (const field of CHANNEL_FIELDS[channel]) {
				const value = values[field.key]?.trim();
				if (value) (settings as unknown as Record<string, string>)[field.key] = value;
			}
			await api.saveNeedsYouChannel(channel, settings);
			setEditing(false);
			await onChanged();
			return null;
		});

	const toggle = (enabled: boolean) =>
		run("toggle", async () => {
			await api.saveNeedsYouChannel(channel, { enabled, ...keptSettings(channel, state) });
			await onChanged();
			return null;
		});

	const test = () =>
		run("test", async () => t(`needsYou.result.${await api.testNeedsYouChannel(channel)}`, { channel: name }));

	const remove = () =>
		Alert.alert(t("needsYou.removeTitle", { channel: name }), t("needsYou.removeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("needsYou.remove"),
				style: "destructive",
				onPress: () =>
					void run("remove", async () => {
						await api.deleteNeedsYouChannel(channel);
						setValues(initialValues(channel, { configured: false }));
						await onChanged();
						return null;
					}),
			},
		]);

	const status = !state.configured
		? { label: t("needsYou.state.notSet"), color: theme.textFaint }
		: !state.readable
			? { label: t("needsYou.state.unreadable"), color: theme.warning }
			: state.enabled
				? { label: t("needsYou.state.on"), color: theme.success }
				: { label: t("needsYou.state.paused"), color: theme.textMuted };

	return (
		<View style={[styles.card, { backgroundColor: theme.surface }, elevation(theme)]}>
			<View style={styles.line}>
				<Text accessibilityRole="header" style={[TYPE.heading, { color: theme.text, flex: 1 }]}>
					{name}
				</Text>
				<Chip label={status.label} color={status.color} />
			</View>
			<Text style={[TYPE.small, { color: theme.textMuted }]}>{t(`needsYou.hints.${channel}`)}</Text>
			{state.configured && rights.write && rights.store ? (
				<View style={styles.line}>
					<Text style={[TYPE.body, { color: theme.text, flex: 1 }]}>{t("needsYou.enabled", { channel: name })}</Text>
					<Switch
						accessibilityLabel={t("needsYou.enabled", { channel: name })}
						value={state.enabled}
						disabled={!readable || busy !== null}
						onValueChange={(on) => void toggle(on)}
					/>
				</View>
			) : null}
			{editing ? (
				<View style={{ gap: SPACE.sm }}>
					{CHANNEL_FIELDS[channel].map((field) => (
						<View key={field.key} style={{ gap: SPACE.xs }}>
							<Field
								label={t(`needsYou.fields.${field.key}`)}
								value={values[field.key]}
								onChangeText={(text) => setValues((current) => ({ ...current, [field.key]: text }))}
								placeholder={
									field.secret && isSet(field.key)
										? t("needsYou.keep")
										: field.key === "server"
											? "https://ntfy.sh"
											: undefined
								}
								secureTextEntry={field.secret}
								autoCapitalize="none"
								autoCorrect={false}
								keyboardType={field.key === "chat_id" ? "number-pad" : field.key === "server" ? "url" : "default"}
								maxLength={field.key === "topic" ? 64 : 2048}
							/>
							{field.key === "topic" ? (
								<Button
									label={t("needsYou.generate")}
									variant="ghost"
									icon="shuffle"
									onPress={() =>
										setValues((current) => ({
											...current,
											topic: `workpilot-${Crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
										}))
									}
								/>
							) : null}
						</View>
					))}
					<View style={styles.line}>
						<View style={{ flex: 1 }}>
							<Button label={t("common.cancel")} variant="secondary" onPress={() => setEditing(false)} />
						</View>
						<View style={{ flex: 1 }}>
							<Button
								label={t("needsYou.save")}
								icon="check"
								busy={busy === "save"}
								disabled={missing || busy !== null}
								onPress={() => void save()}
							/>
						</View>
					</View>
				</View>
			) : rights.write && rights.store ? (
				<View style={styles.buttons}>
					<Button
						label={state.configured ? t("needsYou.change") : t("needsYou.set")}
						variant="secondary"
						icon={state.configured ? "edit-2" : "plus"}
						onPress={() => {
							setValues(initialValues(channel, state));
							setEditing(true);
						}}
					/>
					{readable && rights.send ? (
						<Button label={t("needsYou.test")} variant="secondary" icon="send" busy={busy === "test"} onPress={() => void test()} />
					) : null}
				</View>
			) : null}
			{state.configured && !editing ? (
				<Button label={t("needsYou.remove")} variant="danger" icon="trash-2" busy={busy === "remove"} onPress={remove} />
			) : null}
			<ErrorBanner message={error} />
			{note ? <Text style={[TYPE.small, { color: theme.textMuted }]}>{note}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	card: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md },
	line: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	buttons: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
});
