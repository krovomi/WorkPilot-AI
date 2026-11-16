/**
 * Settings → AI accounts → Auto failover.
 *
 * The switches are the ones the main acts on (ClaudeAutoSwitchSettings, read
 * by agent-process and main/provider-failover), and the chain is the order it
 * walks: every connected account of every provider. A task stopped on a limit
 * or a lost sign-in resumes on the next account, from the phase it stopped in.
 */
import type { ClaudeAutoSwitchSettings } from "@shared/types/agent";
import { normalizeFailoverOrder } from "@shared/utils/failover-chain";
import { ArrowDownUp, ShieldCheck, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { EmptyStage, Notice, Panel } from "../charter";
import { Switch } from "../ui/switch";
import { AccountPriorityList } from "./AccountPriorityList";
import {
	type FailoverAccount,
	isAccountExcluded,
	orderFailoverAccounts,
} from "./failover-accounts";

const DEFAULTS: ClaudeAutoSwitchSettings = {
	enabled: false,
	proactiveSwapEnabled: false,
	usageCheckInterval: 30000,
	sessionThreshold: 95,
	weeklyThreshold: 99,
	autoSwitchOnRateLimit: true,
	autoSwitchOnAuthFailure: true,
};

interface GlobalAutoSwitchingProps {
	/** Every connected account, in their default order (failover-accounts.ts). */
	readonly accounts: readonly FailoverAccount[];
	/** Entries taken out of the chain (settings.disabledAutoSwitchProviders). */
	readonly excluded: readonly string[];
	readonly onExcludedChange: (excluded: string[]) => Promise<boolean>;
	readonly providerLabel: (provider: string) => string;
	/** Told when the switch or the chain length changes, for the page's summary. */
	readonly onSummaryChange?: (summary: { enabled: boolean; chainLength: number }) => void;
}

function ToggleRow({
	id,
	title,
	hint,
	checked,
	disabled,
	onChange,
	children,
}: {
	readonly id: string;
	readonly title: string;
	readonly hint: string;
	readonly checked: boolean;
	readonly disabled?: boolean;
	readonly onChange: (value: boolean) => void;
	readonly children?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<label htmlFor={id} className="text-sm font-medium text-foreground">
						{title}
					</label>
					<p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
				</div>
				<Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
			</div>
			{children}
		</div>
	);
}

function ThresholdField({
	id,
	label,
	value,
	disabled,
	onCommit,
}: {
	readonly id: string;
	readonly label: string;
	readonly value: number;
	readonly disabled: boolean;
	readonly onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const commit = () => {
		if (draft !== value) onCommit(draft);
	};
	return (
		<div className="flex items-center gap-3">
			<label htmlFor={id} className="w-36 shrink-0 text-xs text-muted-foreground">
				{label}
			</label>
			<input
				id={id}
				type="range"
				min={50}
				max={99}
				step={1}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(Number(event.target.value))}
				onPointerUp={commit}
				onKeyUp={commit}
				onBlur={commit}
				className="flex-1 accent-[var(--primary)]"
			/>
			<span className="wp-mono w-10 text-right text-xs text-foreground">{draft}%</span>
		</div>
	);
}

export function GlobalAutoSwitching({
	accounts,
	excluded,
	onExcludedChange,
	providerLabel,
	onSummaryChange,
}: GlobalAutoSwitchingProps) {
	const { t } = useTranslation("settings");
	const { toast } = useToast();
	const [settings, setSettings] = useState<ClaudeAutoSwitchSettings | null>(null);
	const [savedOrder, setSavedOrder] = useState<string[] | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			globalThis.electronAPI.getAutoSwitchSettings(),
			globalThis.electronAPI.getAccountPriorityOrder(),
		])
			.then(([switches, order]) => {
				if (cancelled) return;
				setSettings({ ...DEFAULTS, ...(switches.success ? switches.data : {}) });
				setSavedOrder(order.success ? (normalizeFailoverOrder(order.data) ?? []) : []);
			})
			.catch((error) => {
				console.error("[GlobalAutoSwitching] Failed to load failover settings:", error);
				if (!cancelled) {
					setSettings(DEFAULTS);
					setSavedOrder([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const ordered = useMemo(
		() => (savedOrder ? orderFailoverAccounts(accounts, savedOrder) : []),
		[accounts, savedOrder],
	);
	const chainLength = ordered.filter((account) => !isAccountExcluded(account, excluded)).length;

	// The main walks the saved order: keep it equal to the accounts shown, so a
	// provider connected since is in the chain without a drag.
	useEffect(() => {
		if (!savedOrder) return;
		const ids = ordered.map((account) => account.id);
		if (ids.length === 0 || ids.join("\n") === savedOrder.join("\n")) return;
		setSavedOrder(ids);
		void globalThis.electronAPI.setAccountPriorityOrder(ids).catch((error: unknown) => {
			console.error("[GlobalAutoSwitching] Failed to save the failover chain:", error);
		});
	}, [ordered, savedOrder]);

	useEffect(() => {
		if (settings) onSummaryChange?.({ enabled: settings.enabled, chainLength });
	}, [settings, chainLength, onSummaryChange]);

	const update = async (patch: Partial<ClaudeAutoSwitchSettings>) => {
		if (!settings) return;
		const previous = settings;
		setSettings({ ...settings, ...patch });
		setSaving(true);
		try {
			const result = await globalThis.electronAPI.updateAutoSwitchSettings(patch);
			if (!result.success) throw new Error(result.error);
		} catch (error) {
			console.error("[GlobalAutoSwitching] Failed to save:", error);
			setSettings(previous);
			toast({ variant: "destructive", title: t("aiAccounts.failover.saveError") });
		} finally {
			setSaving(false);
		}
	};

	const reorder = async (ids: string[]) => {
		const previous = savedOrder;
		setSavedOrder(ids);
		try {
			const result = await globalThis.electronAPI.setAccountPriorityOrder(ids);
			if (!result.success) throw new Error(result.error);
		} catch (error) {
			console.error("[GlobalAutoSwitching] Failed to save the order:", error);
			setSavedOrder(previous);
			toast({ variant: "destructive", title: t("aiAccounts.failover.orderError") });
		}
	};

	const include = async (id: string, included: boolean) => {
		const account = ordered.find((a) => a.id === id);
		const rest = excluded.filter(
			(item) => item !== id && !(account?.kind === "provider" && item === account.provider),
		);
		const saved = await onExcludedChange(included ? rest : [...rest, id]);
		if (!saved) toast({ variant: "destructive", title: t("aiAccounts.failover.saveError") });
	};

	if (!settings) return null;
	const off = !settings.enabled;

	return (
		<div className="flex flex-col gap-4">
			<Panel rail tone={settings.enabled ? "green" : "muted"} className="flex items-start gap-4">
				<span className="wp-empty-glyph shrink-0" aria-hidden="true">
					<ShieldCheck className="h-4 w-4" />
				</span>
				<div className="min-w-0 flex-1">
					<label htmlFor="failover-enabled" className="wp-title text-sm">
						{t("aiAccounts.failover.masterTitle")}
					</label>
					<p className="mt-1 text-xs text-muted-foreground">
						{settings.enabled ? t("aiAccounts.failover.masterOn") : t("aiAccounts.failover.masterOff")}
					</p>
				</div>
				<Switch
					id="failover-enabled"
					checked={settings.enabled}
					disabled={saving}
					onCheckedChange={(enabled) => void update({ enabled })}
				/>
			</Panel>

			<div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
				<Panel className={cn("flex flex-col self-start", off && "opacity-60")}>
					<h4 className="wp-kicker mb-3 flex items-center gap-1.5">
						<Zap className="h-3.5 w-3.5" aria-hidden="true" />
						{t("aiAccounts.failover.triggersTitle")}
					</h4>
					<div className="flex flex-col divide-y divide-border">
						<ToggleRow
							id="failover-rate-limit"
							title={t("aiAccounts.failover.rateLimit")}
							hint={t("aiAccounts.failover.rateLimitHint")}
							checked={settings.autoSwitchOnRateLimit}
							disabled={off || saving}
							onChange={(value) => void update({ autoSwitchOnRateLimit: value })}
						/>
						<ToggleRow
							id="failover-auth"
							title={t("aiAccounts.failover.authFailure")}
							hint={t("aiAccounts.failover.authFailureHint")}
							checked={settings.autoSwitchOnAuthFailure}
							disabled={off || saving}
							onChange={(value) => void update({ autoSwitchOnAuthFailure: value })}
						/>
						<ToggleRow
							id="failover-proactive"
							title={t("aiAccounts.failover.proactive")}
							hint={t("aiAccounts.failover.proactiveHint")}
							checked={settings.proactiveSwapEnabled}
							disabled={off || saving}
							onChange={(value) => void update({ proactiveSwapEnabled: value })}
						>
							{settings.proactiveSwapEnabled && (
								<div className="flex flex-col gap-2">
									<ThresholdField
										id="failover-session"
										label={t("aiAccounts.failover.session")}
										value={settings.sessionThreshold}
										disabled={off || saving}
										onCommit={(value) => void update({ sessionThreshold: value })}
									/>
									<ThresholdField
										id="failover-weekly"
										label={t("aiAccounts.failover.weekly")}
										value={settings.weeklyThreshold}
										disabled={off || saving}
										onCommit={(value) => void update({ weeklyThreshold: value })}
									/>
								</div>
							)}
						</ToggleRow>
					</div>
				</Panel>

				<Panel className="flex flex-col gap-3">
					<div>
						<h4 className="wp-kicker flex items-center gap-1.5">
							<ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
							{t("aiAccounts.failover.chainTitle")}
						</h4>
						<p className="mt-1 text-xs text-muted-foreground">
							{t("aiAccounts.failover.chainDescription")}
						</p>
					</div>
					{ordered.length === 0 ? (
						<EmptyStage icon={ArrowDownUp} title={t("aiAccounts.failover.chainEmpty")} tone="muted" />
					) : (
						<>
							{chainLength < 2 && (
								<Notice tone="amber">{t("aiAccounts.failover.chainSingle")}</Notice>
							)}
							<AccountPriorityList
								accounts={ordered}
								excluded={(account) => isAccountExcluded(account, excluded)}
								providerLabel={providerLabel}
								onReorder={(ids) => void reorder(ids)}
								onInclude={(id, included) => void include(id, included)}
							/>
						</>
					)}
				</Panel>
			</div>
		</div>
	);
}
