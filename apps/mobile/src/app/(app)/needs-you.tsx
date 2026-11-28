/**
 * "Notify me elsewhere": the person's own channels on the server (ntfy,
 * Telegram, Teams) and the moments they are told of. Everything is the
 * server's (`server/routers/needs_you.py`): the phone only shows and sends.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useApi, useSession } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { ChannelCard } from "../../needs-you/ChannelCard";
import { CHANNELS, MOMENTS, type Moment, type NeedsYouOverview } from "../../needs-you/types";
import { ErrorBanner, Loading, Section } from "../../ui/components";
import { RADIUS, SPACE, TYPE, useTheme } from "../../ui/theme";

const LANGUAGES = ["en", "fr"] as const;

export default function NeedsYou() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const load = useCallback(() => api.needsYou(), [api]);
	const { data, error, loading, refreshing, reload, refresh } = useLoad(load);
	if (loading && !data) return <Loading />;
	const write = can("agent.execute");
	const rights = { write, store: !!data?.vault, send: !!data?.available };
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={[TYPE.body, { color: theme.textMuted }]}>{t("needsYou.intro")}</Text>
			<ErrorBanner error={error} />
			{data ? (
				<>
					{data.available ? null : <Note text={t("needsYou.off")} />}
					{data.vault ? null : <Note text={t("needsYou.noVault")} />}
					{write ? null : <Note text={t("needsYou.readOnly")} />}
					{/* Drawn again when the server's answer differs from what is shown. */}
					<Moments key={momentsKey(data)} overview={data} />
					{CHANNELS.map((channel) => (
						<ChannelCard
							key={channel}
							channel={channel}
							state={data.channels[channel] ?? { configured: false }}
							rights={rights}
							onChanged={refresh}
						/>
					))}
				</>
			) : null}
		</ScrollView>
	);
}

function readMoments(overview: NeedsYouOverview): Record<Moment, boolean> {
	return Object.fromEntries(MOMENTS.map((moment) => [moment, overview.events[moment] !== false])) as Record<
		Moment,
		boolean
	>;
}

function momentsKey(overview: NeedsYouOverview): string {
	const on = readMoments(overview);
	return `${overview.locale}:${MOMENTS.map((moment) => (on[moment] ? 1 : 0)).join("")}`;
}

function Note({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<View style={[styles.note, { backgroundColor: theme.elevated }]}>
			<Text style={[TYPE.small, { color: theme.text }]}>{text}</Text>
		</View>
	);
}

/** The moments told of and the language of the messages, saved as soon as changed. */
function Moments({ overview }: { overview: NeedsYouOverview }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [events, setEvents] = useState(() => readMoments(overview));
	const [locale, setLocale] = useState(overview.locale);
	const [error, setError] = useState<string | null>(null);

	const save = async (nextEvents: Record<Moment, boolean>, nextLocale: string) => {
		const before = { events, locale };
		setEvents(nextEvents);
		setLocale(nextLocale);
		setError(null);
		try {
			await api.saveNeedsYouMoments(nextEvents, nextLocale);
		} catch (err) {
			setEvents(before.events);
			setLocale(before.locale);
			setError(describeError(err));
		}
	};

	return (
		<Section title={t("needsYou.moments")} icon="bell">
			{MOMENTS.map((moment) => (
				<View key={moment} style={styles.row}>
					<Text style={[TYPE.body, { color: theme.text, flex: 1 }]}>{t(`needsYou.events.${moment}`)}</Text>
					<Switch
						accessibilityLabel={t(`needsYou.events.${moment}`)}
						value={events[moment]}
						onValueChange={(on) => void save({ ...events, [moment]: on }, locale)}
					/>
				</View>
			))}
			<Text style={[TYPE.label, { color: theme.textMuted }]}>{t("needsYou.language")}</Text>
			<View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: theme.elevated }]}>
				{LANGUAGES.map((language) => {
					const selected = locale === language;
					return (
						<Pressable
							key={language}
							accessibilityRole="radio"
							accessibilityState={{ selected }}
							onPress={() => (selected ? undefined : void save(events, language))}
							style={[styles.segment, selected ? { backgroundColor: theme.surface } : null]}
						>
							<Text style={[TYPE.label, { color: selected ? theme.text : theme.textMuted }]}>
								{t(`needsYou.languages.${language}`)}
							</Text>
						</Pressable>
					);
				})}
			</View>
			<ErrorBanner message={error} />
		</Section>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	note: { borderRadius: RADIUS.md, padding: SPACE.md },
	row: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
	segments: { flexDirection: "row", borderRadius: RADIUS.md, padding: 3, gap: 3 },
	segment: { flex: 1, alignItems: "center", paddingVertical: SPACE.sm, borderRadius: RADIUS.sm },
});
