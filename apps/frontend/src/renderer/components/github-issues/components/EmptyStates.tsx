import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Globe } from "@/lib/icons";
import { Button } from "../../ui/button";
import { EmptyState as SharedEmptyState } from "../../ui/empty-state";
import type { EmptyStateProps, NotConnectedStateProps } from "../types";

export function EmptyState({
	searchQuery,
	icon = Globe,
	message,
}: EmptyStateProps) {
	const { t } = useTranslation();
	return (
		<SharedEmptyState
			icon={icon}
			description={searchQuery ? t("common:githubIssues.noMatch") : message}
		/>
	);
}

export function NotConnectedState({
	error,
	onOpenSettings,
}: NotConnectedStateProps) {
	const { t } = useTranslation();
	return (
		<SharedEmptyState
			icon={Globe}
			title={t("common:githubIssues.notConnected")}
			description={error || t("common:githubIssues.notConnectedDescription")}
			action={
				onOpenSettings && (
					<Button onClick={onOpenSettings} variant="outline">
						<Settings2 className="h-4 w-4 mr-2" />
						{t("common:prReview.openSettings")}
					</Button>
				)
			}
		/>
	);
}
