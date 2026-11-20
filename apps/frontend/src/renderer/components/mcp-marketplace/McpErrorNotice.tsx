/**
 * What the marketplace store could not do (load, install, remove, save),
 * worded in the app's language, with the main process's own message under it.
 */

import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMcpMarketplaceStore } from "../../stores/mcp-marketplace-store";
import { Notice } from "../charter";

export function McpErrorNotice({ className }: { readonly className?: string }) {
	const { t } = useTranslation(["common"]);
	const error = useMcpMarketplaceStore((s) => s.error);
	if (!error) return null;
	return (
		<Notice tone="red" icon={AlertTriangle} role="alert" className={className}>
			<p>{t(`mcpMarketplace.errors.${error.key}`, { name: error.name })}</p>
			{error.detail && <p className="text-xs opacity-80">{error.detail}</p>}
		</Notice>
	);
}
