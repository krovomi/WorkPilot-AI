import { ShieldAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useSecureStorageStore } from "../stores/secure-storage-store";

/** Stable empty list, so the selector does not re-render on every store update. */
const NO_FILES: string[] = [];

interface SecureStorageBannerProps {
	className?: string;
}

/**
 * Sidebar warning shown while API keys or tokens are stored without the OS
 * keyring (Linux without GNOME Keyring / KWallet, typically), or kept in clear
 * in a file another process reads (the backend's own .env when running from
 * source). Rule S1: a secret is never written in clear without the user being
 * told.
 */
export function SecureStorageBanner({ className }: SecureStorageBannerProps) {
	const { t } = useTranslation("navigation");
	const atRisk = useSecureStorageStore((s) => !!s.status?.secretsAtRisk);
	const encryptionUnavailable = useSecureStorageStore(
		(s) => !!s.status?.encryptionUnavailable,
	);
	const plaintextFiles = useSecureStorageStore(
		(s) => s.status?.plaintextFiles ?? NO_FILES,
	);
	const dismissed = useSecureStorageStore((s) => s.dismissed);
	const dismiss = useSecureStorageStore((s) => s.dismiss);

	if (!atRisk || dismissed) return null;

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
			{encryptionUnavailable && (
				<>
					<p className="text-xs text-muted-foreground mb-1">
						{t("secureStorageBanner.description")}
					</p>
					<p className="text-xs text-muted-foreground">
						{t("secureStorageBanner.action")}
					</p>
				</>
			)}
			{plaintextFiles.length > 0 && (
				<div className={cn(encryptionUnavailable && "mt-2")}>
					<p className="text-xs text-muted-foreground mb-1">
						{t("secureStorageBanner.plaintextFiles.description")}
					</p>
					<ul className="mb-1">
						{plaintextFiles.map((file) => (
							<li key={file}>
								<code className="text-xs break-all text-foreground">
									{file}
								</code>
							</li>
						))}
					</ul>
					<p className="text-xs text-muted-foreground">
						{t("secureStorageBanner.plaintextFiles.action")}
					</p>
				</div>
			)}
		</div>
	);
}
