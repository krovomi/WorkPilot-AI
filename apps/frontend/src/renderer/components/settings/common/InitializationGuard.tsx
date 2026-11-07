import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface InitializationGuardProps {
	initialized: boolean;
	title: string;
	description: string;
	children: ReactNode;
}

/**
 * Guard component that shows a message when WorkPilot AI is not initialized.
 * Used to prevent configuration of features that require WorkPilot AI setup.
 */
export function InitializationGuard({
	initialized,
	title,
	description: _description,
	children,
}: InitializationGuardProps) {
	const { t } = useTranslation();
	if (!initialized) {
		return (
			<div className="rounded-lg border border-border bg-muted/50 p-4 text-center text-sm text-muted-foreground">
				{t("settings:projectSelector.initializeFirst", {
					section: title.toLowerCase(),
				})}
			</div>
		);
	}

	return <>{children}</>;
}
