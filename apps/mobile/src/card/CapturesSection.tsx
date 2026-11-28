/**
 * The card's captures for its pull request, in a line: how many screens, what
 * the pull request shows, and that personal data are fakes. The screens
 * themselves, before and after, are a screen of their own (`cards/[cardId]/captures`).
 * The card screen gives it a new `key` after an action, so it reads again.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { useApi } from "../auth/session";
import { hasCaptures, stateKey } from "../captures/describe";
import type { CardCaptures } from "../captures/types";
import { Button, Section } from "../ui/components";
import { useTheme } from "../ui/theme";

export function CapturesSection({
	projectId,
	cardId,
	onOpen,
}: {
	projectId: string;
	cardId: string;
	onOpen: () => void;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [captures, setCaptures] = useState<CardCaptures | null>(null);

	const load = useCallback(async () => {
		try {
			setCaptures(await api.captures(projectId, cardId));
		} catch {
			// A server without the route, or a card without captures: no section.
			setCaptures(null);
		}
	}, [api, projectId, cardId]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!hasCaptures(captures)) return null;
	return (
		<Section title={t("captures.title")} icon="image">
			<Text style={{ color: theme.text }}>
				{t("captures.count", { count: captures.items.length })}
				{captures.withheld > 0 ? ` · ${t("captures.withheld", { count: captures.withheld })}` : ""}
			</Text>
			<Text style={{ color: theme.textMuted }}>{t(stateKey(captures))}</Text>
			{captures.protect === false ? (
				<Text style={{ color: theme.warning }}>{t("captures.unprotected")}</Text>
			) : (
				<Text style={{ color: theme.textFaint }}>{t("captures.fakesNote")}</Text>
			)}
			<Button label={t("captures.open")} icon="maximize-2" variant="ghost" onPress={onOpen} />
		</Section>
	);
}
