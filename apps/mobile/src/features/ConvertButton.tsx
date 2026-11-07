/** Turn a roadmap feature or an idea into a card, then open it; or open the card it became. */

import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { Button } from "../ui/components";
import { useTheme } from "../ui/theme";

export function ConvertButton({
	projectId,
	linkedCardId,
	convert,
	onConverted,
}: {
	projectId: string;
	linkedCardId: string | null;
	convert: () => Promise<{ card: { id: string } }>;
	onConverted: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can } = useSession();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const open = (cardId: string) =>
		router.push({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId, cardId } });

	if (linkedCardId) {
		return <Button label={t("features.openCard")} variant="secondary" onPress={() => open(linkedCardId)} />;
	}
	if (!can("task.write")) return null;
	return (
		<>
			{error ? <Text style={{ color: theme.danger }}>{error}</Text> : null}
			<Button
				label={t("features.toCard")}
				variant="secondary"
				busy={busy}
				onPress={async () => {
					setBusy(true);
					setError(null);
					try {
						const { card } = await convert();
						await onConverted();
						open(card.id);
					} catch (err) {
						setError(describeError(err));
					} finally {
						setBusy(false);
					}
				}}
			/>
		</>
	);
}
