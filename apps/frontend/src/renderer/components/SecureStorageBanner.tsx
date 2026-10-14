import { ShieldAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useSecureStorageStore } from "../stores/secure-storage-store";

const NO_KEYS: string[] = [];

interface SecureStorageBannerProps {
	className?: string;
}

/**
 * Sidebar warning shown while API keys or tokens are stored without the OS
 * keyring (Linux without GNOME Keyring / KWallet, typically), or kept in clear
 * in a project's `.workpilot/.env` because the Python backend reads them from
 * there. Rule S1: a secret is never written in clear without the user being
 * told.
 */
export function SecureStorageBanner({ className }: SecureStorageBannerProps) {
	const { t } = useTranslation("navigation");
	const atRisk = useSecureStorageStore((s) => !!s.status?.secretsAtRisk);
	const keyringAvailable = useSecureStorageStore(
		(s) => !!s.status?.keyringAvailable,
	);
	const readableKeys = useSecureStorageStore(
		(s) => s.status?.readableSecretKeys ?? NO_KEYS,
	);
	const dismissed = useSecureStorageStore((s) => s.dismissed);
	const dismiss = useSecureStorageStore((s) => s.dismiss);

	if (!atRisk || dismissed) return null;

	// No keyring covers every secret; with one, only the readable keys remain.
	const onlyReadable = keyringAvailable && readableKeys.length > 0;

	return (
		<div
			role="alert"
			className={cn(
				"mx-3 mb-3 rounded-lg border border-warning/30 bg-warning/10 p-3",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<ShieldAlert className="h-4 w-4 text-warning shrink-0" />
					<span className="text-xs font-medium text-foreground">
						{t("secureStorageBanner.title")}
					</span>
				</div>
				<button
					type="button"
					onClick={dismiss}
					className="text-muted-foreground hover:text-foreground transition-colors"
					aria-label={t("secureStorageBanner.dismiss")}
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
			<p className="text-xs text-muted-foreground mb-1">
				{onlyReadable
					? t("secureStorageBanner.readableDescription", {
							keys: readableKeys.join(", "),
						})
					: t("secureStorageBanner.description")}
			</p>
			<p className="text-xs text-muted-foreground">
				{onlyReadable
					? t("secureStorageBanner.readableAction")
					: t("secureStorageBanner.action")}
			</p>
		</div>
	);
}
