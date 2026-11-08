import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Notice, Panel, Section } from "../charter";
import { translateBackendError } from "./_translate-backend-error";

interface PanelShellProps {
	readonly title: string;
	readonly subtitle?: string;
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly error?: string | null;
}

/**
 * The charter section every Phase 3-5 panel sits in: kicker, title,
 * description, actions, then the body in a card and the error as a notice.
 *
 * Backend error strings (raw English from the Python API) are routed
 * through the localizer so users see French messages in FR mode.
 */
export function PanelShell({ title, subtitle, actions, children, error }: PanelShellProps) {
	const { t } = useTranslation(["phase35", "navigation"]);
	const localizedError = translateBackendError(error, t);
	return (
		<Section
			kicker={t("navigation:items.phase35Hub")}
			title={title}
			description={subtitle}
			actions={actions ? <div className="flex items-center gap-2">{actions}</div> : undefined}
		>
			{localizedError && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="mb-3">
					{localizedError}
				</Notice>
			)}
			<Panel>{children}</Panel>
		</Section>
	);
}
