/**
 * What the card runs with: its engine, priority and goal, as the server
 * will hand them to the build. Read only on the phone; the desktop edits them.
 */

import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import type { CardSettings } from "../api/types";
import { Section } from "../ui/components";
import { useTheme } from "../ui/theme";
import { mono } from "./LongText";

export function engineLabel(engine: NonNullable<CardSettings["engine"]>, auto: string): string {
	const parts = [engine.provider, engine.isAutoProfile ? auto : engine.model, engine.thinkingLevel];
	return parts.filter(Boolean).join(" · ");
}

export function SettingsSection({ settings }: { settings?: CardSettings }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (!settings) return null;
	const { engine, priority, goal, goalError } = settings;
	if (!engine && !priority && !goal && !goalError) return null;
	return (
		<Section title={t("card.settings")}>
			{engine ? (
				<Text style={{ color: theme.text }}>
					{t("card.engine", { engine: engineLabel(engine, t("card.engineAuto")) })}
				</Text>
			) : null}
			{priority ? (
				<Text style={{ color: theme.text }}>
					{t("card.priority", { priority: t(`card.priority_${priority}`, { defaultValue: priority }) })}
				</Text>
			) : null}
			{goal ? (
				<>
					<Text style={{ color: theme.text }}>{t("card.goal")}</Text>
					<Text style={[mono.text, { color: theme.text }]} selectable>
						{goal.command}
					</Text>
				</>
			) : null}
			{goalError ? <Text style={{ color: theme.danger }}>{t("card.goalError", { error: goalError })}</Text> : null}
		</Section>
	);
}
