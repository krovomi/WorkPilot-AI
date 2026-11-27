import type { AuthMethod, ProfileUsageSummary } from "@shared/types/agent";
import { KeyRound, LogIn, Pencil, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import {
	SECRET_RENEWAL_DAYS,
	secretAgeDays,
	secretNeedsRenewal,
} from "../../../shared/utils/secret-age";
import { Bar, CharterButton, Chip, Panel, type Tone } from "../charter";
import { GUIDE_ANCHORS } from "../guided-tour/anchors";
import { ProviderIcon } from "./provider-icons";

export interface ProviderCardData {
	id: string;
	name: string;
	description?: string;
	isConfigured: boolean;
	/** False when its last connection test failed. */
	isWorking?: boolean;
	lastTested?: string;
	realUsageData?: ProfileUsageSummary;
	realApiKeyInfo?: {
		hasKey: boolean;
		provider?: string;
		authMethod?: AuthMethod;
		/** When the stored key got its value; undefined when unknown. */
		setAt?: string | number;
	};
	/** Its accounts (Settings → AI accounts), when it can have several. */
	accounts?: {
		count: number;
		/** The account it runs on, when one is named. */
		defaultName?: string;
	};
}

export type ProviderCardStatus = "connected" | "reauth" | "failing" | "off";

/** What a card says about its provider, in the order a person cares about. */
export function providerCardStatus(provider: ProviderCardData): ProviderCardStatus {
	if (!provider.isConfigured) return "off";
	if (provider.realUsageData?.needsReauthentication === true) return "reauth";
	if (provider.isWorking === false) return "failing";
	return "connected";
}

const STATUS_TONE: Record<ProviderCardStatus, Tone> = {
	connected: "green",
	reauth: "amber",
	failing: "red",
	off: "muted",
};

interface CleanProviderCardProps {
	readonly provider: ProviderCardData;
	readonly isDefault?: boolean;
	readonly isTesting?: boolean;
	readonly onConfigure?: (providerId: string, options?: { startOAuth?: boolean }) => void;
	readonly onTest?: (providerId: string) => void;
	readonly onSetDefault?: (providerId: string) => void;
	readonly onManageAccounts?: (providerId: string) => void;
}

/** One provider of Settings → AI accounts: its state, how it signs in, what to do next. */
export function CleanProviderCard({
	provider,
	isDefault = false,
	isTesting = false,
	onConfigure,
	onTest,
	onSetDefault,
	onManageAccounts,
}: CleanProviderCardProps) {
	const { t } = useTranslation("settings");
	const status = providerCardStatus(provider);
	const tone = STATUS_TONE[status];
	const usage = provider.realUsageData;
	const authMethod = provider.realApiKeyInfo?.authMethod;

	// A stored API key says how old it is; past SECRET_RENEWAL_DAYS the card
	// suggests renewing it. An undated key is never called old nor new.
	const hasStoredKey =
		provider.realApiKeyInfo?.hasKey === true && authMethod === "api-key";
	const keyAgeDays = hasStoredKey ? secretAgeDays(provider.realApiKeyInfo?.setAt) : undefined;
	const keyNeedsRenewal = secretNeedsRenewal(keyAgeDays);

	const facts: string[] = [];
	if (status !== "off" && authMethod) facts.push(t(`aiAccounts.card.auth.${authMethod}`));
	if (provider.accounts?.defaultName) {
		facts.push(t("aiAccounts.card.account", { name: provider.accounts.defaultName }));
	} else if (provider.realApiKeyInfo?.provider) facts.push(provider.realApiKeyInfo.provider);
	if (hasStoredKey && keyAgeDays !== undefined) {
		facts.push(
			keyAgeDays === 0
				? t("aiAccounts.card.keyToday")
				: t("aiAccounts.card.keyAge", { count: keyAgeDays }),
		);
	}
	if (status !== "off") {
		facts.push(
			provider.lastTested
				? t("aiAccounts.card.lastTest", {
						date: formatAppDateTime(provider.lastTested, {
							day: "2-digit",
							month: "2-digit",
							hour: "2-digit",
							minute: "2-digit",
						}),
					})
				: t("aiAccounts.card.neverTested"),
		);
	}

	return (
		<Panel
			rail={status !== "off"}
			tone={tone}
			className={cn("flex flex-col gap-3", status === "off" && "opacity-90")}
			data-provider={provider.id}
			data-status={status}
		>
			<div className="flex items-start gap-3">
				<ProviderIcon provider={provider.id} label={provider.name} />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h3 className="wp-title truncate text-sm">{provider.name}</h3>
						{isDefault && (
							<Chip tone="accent" dot={false}>
								{t("aiAccounts.card.default")}
							</Chip>
						)}
					</div>
					{provider.description && (
						<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
							{provider.description}
						</p>
					)}
				</div>
				<Chip tone={tone}>{t(`aiAccounts.card.status.${status}`)}</Chip>
			</div>

			{facts.length > 0 && <p className="wp-meta truncate">{facts.join(" · ")}</p>}

			{usage && status !== "off" && (
				<div className="flex flex-col gap-1">
					<Bar
						value={usage.sessionPercent}
						tone={usage.sessionPercent >= 90 ? "red" : usage.sessionPercent >= 70 ? "amber" : "green"}
					/>
					<span className="wp-meta">
						{usage.weeklyPercent
							? t("aiAccounts.card.usageWeekly", {
									session: Math.round(usage.sessionPercent),
									weekly: Math.round(usage.weeklyPercent),
								})
							: t("aiAccounts.card.usage", { session: Math.round(usage.sessionPercent) })}
					</span>
				</div>
			)}

			{keyNeedsRenewal && (
				<p className="wp-tone-amber wp-ink text-xs">
					{t("sections.accounts.providerCard.keyRenewal", {
						count: keyAgeDays,
						threshold: SECRET_RENEWAL_DAYS,
					})}
				</p>
			)}

			<div className="mt-auto flex flex-wrap items-center gap-2">
				{status === "off" && (
					<CharterButton
						size="sm"
						icon={KeyRound}
						data-guide={GUIDE_ANCHORS.providers.configure}
						onClick={() => onConfigure?.(provider.id)}
					>
						{t("aiAccounts.card.connect")}
					</CharterButton>
				)}
				{status === "reauth" && (
					<CharterButton
						size="sm"
						icon={LogIn}
						onClick={() => onConfigure?.(provider.id, { startOAuth: true })}
					>
						{t("aiAccounts.card.reconnect")}
					</CharterButton>
				)}
				{provider.accounts && onManageAccounts && (
					<CharterButton
						size="sm"
						variant="ghost"
						icon={Users}
						data-action="accounts"
						onClick={() => onManageAccounts(provider.id)}
					>
						{t("aiAccounts.card.accounts", { count: provider.accounts.count })}
					</CharterButton>
				)}
				{status !== "off" && (
					<>
						<CharterButton
							size="sm"
							variant="ghost"
							busy={isTesting}
							disabled={isTesting}
							onClick={() => onTest?.(provider.id)}
						>
							{isTesting ? t("aiAccounts.card.testing") : t("aiAccounts.card.test")}
						</CharterButton>
						<CharterButton
							size="sm"
							variant="ghost"
							icon={Pencil}
							onClick={() => onConfigure?.(provider.id)}
						>
							{t("aiAccounts.card.edit")}
						</CharterButton>
						{!isDefault && status === "connected" && onSetDefault && (
							<CharterButton
								size="sm"
								variant="ghost"
								icon={Star}
								className="ml-auto"
								onClick={() => onSetDefault(provider.id)}
							>
								{t("aiAccounts.card.setDefault")}
							</CharterButton>
						)}
					</>
				)}
			</div>
		</Panel>
	);
}
