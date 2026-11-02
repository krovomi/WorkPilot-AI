import { Globe, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { EmptyState as SharedEmptyState } from "../../ui/empty-state";
import type { EmptyStateProps, NotConnectedStateProps } from "../types";

export function EmptyState({
	searchQuery,
	icon = Globe,
	message,
}: EmptyStateProps) {
	const { t } = useTranslation("gitlab");

	return (
		<SharedEmptyState
			icon={icon}
			description={searchQuery ? t("empty.noMatch") : message}
		/>
	);
}

export function NotConnectedState({
	error,
	onOpenSettings,
}: NotConnectedStateProps) {
	const { t } = useTranslation("gitlab");

	return (
		<SharedEmptyState
			icon={Globe}
			title={t("notConnected.title")}
			description={error || t("notConnected.description")}
			action={
				onOpenSettings && (
					<Button onClick={onOpenSettings} variant="outline">
						<Settings2 className="h-4 w-4 mr-2" />
						{t("notConnected.openSettings")}
					</Button>
				)
			}
		/>
	);
}
