import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SecureStorageStatus } from "../../shared/types/ipc";
import { cn } from "../lib/utils";
import { useSecureStorageStore } from "../stores/secure-storage-store";
import { saveSettings, useSettingsStore } from "../stores/settings-store";
import { Button } from "./ui/button";

const NO_KEYS: string[] = [];

interface SecureStorageBannerProps {
	className?: string;
}

/**
 * The situation a "Don't show again" hides: no encryption at all, or these
 * keys kept readable. A situation the user has not hidden yet (another key
 * kept readable, encryption lost) shows the banner again.
 */
export function bannerFingerprint(
	status: Pick<SecureStorageStatus, "keyringAvailable" | "readableSecretKeys">,
): string {
	if (!status.keyringAvailable) return "no-encryption";
	return `readable:${[...status.readableSecretKeys].sort().join(",")}`;
}

/**
 * Sidebar warning shown while API keys or tokens are stored unencrypted
 * (Linux without GNOME Keyring / KWallet, WSL when Windows DPAPI cannot be
 * reached), or kept in clear in a project's `.workpilot/.env` because the
 * Python backend reads them from there. Rule S1: a secret is never written in
 * clear without the user being told. Its button fixes what can be fixed in one
 * click (the main decides: retry DPAPI under WSL, restart elsewhere on Linux);
 * "Don't show again" hides this situation for good, a new one shows again.
 */
export function SecureStorageBanner({ className }: SecureStorageBannerProps) {
	const { t } = useTranslation("navigation");
	const status = useSecureStorageStore((s) => s.status);
	const readableKeys = useSecureStorageStore(
		(s) => s.status?.readableSecretKeys ?? NO_KEYS,
	);
	const dismissed = useSecureStorageStore((s) => s.dismissed);
	const dismiss = useSecureStorageStore((s) => s.dismiss);
	const fixSecureStorage = useSecureStorageStore((s) => s.fix);
	const hidden = useSettingsStore((s) => s.settings.secureStorageBannerHidden);
	const [fixing, setFixing] = useState(false);
	const [fixFailed, setFixFailed] = useState(false);

	if (!status?.secretsAtRisk || dismissed) return null;
	const fingerprint = bannerFingerprint(status);
	if (hidden === fingerprint) return null;

	// No encryption covers every secret; with it, only the readable keys remain.
	const onlyReadable = status.keyringAvailable && readableKeys.length > 0;
	const fix = onlyReadable ? null : (status.fix ?? null);

	let description = t("secureStorageBanner.description");
	let action = t("secureStorageBanner.action");
	if (onlyReadable) {
		description = t("secureStorageBanner.readableDescription", {
			keys: readableKeys.join(", "),
		});
		action = t("secureStorageBanner.readableAction");
	} else if (fix === "retry") {
		description = t("secureStorageBanner.wslDescription");
		action = t("secureStorageBanner.wslAction");
	}

	const runFix = async () => {
		setFixing(true);
		setFixFailed(false);
		const fixed = await fixSecureStorage();
		setFixing(false);
		setFixFailed(!fixed);
	};

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
			<p className="text-xs text-muted-foreground mb-1">{description}</p>
			<p className="text-xs text-muted-foreground">{action}</p>
			{fixFailed && (
				<p className="mt-1 text-xs text-warning">
					{t("secureStorageBanner.retryFailed")}
				</p>
			)}
			<div className="mt-2 flex flex-wrap gap-2">
				{fix && (
					<Button
						size="sm"
						variant="warning"
						disabled={fixing}
						onClick={() => void runFix()}
					>
						{fix === "restart"
							? t("secureStorageBanner.restart")
							: fixing
								? t("secureStorageBanner.retrying")
								: t("secureStorageBanner.retry")}
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						void saveSettings({ secureStorageBannerHidden: fingerprint })
					}
				>
					{t("secureStorageBanner.hideForGood")}
				</Button>
			</div>
		</div>
	);
}
