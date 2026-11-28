/**
 * The routing options of a gateway, on its provider page. OpenRouter: the
 * provider order, two privacy filters and fallback models; Hugging Face: the
 * router's policy. Each change is saved at once through the settings store;
 * the main turns them into environment variables for the backend
 * (`shared/constants/gateway-routing.ts`), which reads them again.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	cleanFallbackModels,
	HUGGINGFACE_POLICIES,
	isGatewayModelId,
	MAX_FALLBACK_MODELS,
	OPENROUTER_SORTS,
} from "../../../shared/constants/gateway-routing";
import type { GatewayProviderId } from "../../../shared/constants/gateway-providers";
import type { AppSettings } from "../../../shared/types/settings";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { cn } from "../../lib/utils";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/** One input per fallback, in order. */
const FALLBACK_SLOTS = Array.from({ length: MAX_FALLBACK_MODELS }, (_, i) => `fallback-${i + 1}`);

const selectClass =
	"w-full text-sm rounded-md border border-input bg-background text-foreground px-2 py-1.5";

interface GatewayRoutingOptionsProps {
	readonly provider: GatewayProviderId;
	readonly className?: string;
}

export function GatewayRoutingOptions({ provider, className }: GatewayRoutingOptionsProps) {
	const { t } = useTranslation("settings");
	const tr = (key: string, opts?: Record<string, unknown>) =>
		t(`sections.accounts.gatewayRouting.${key}`, opts ?? {});
	const [failed, setFailed] = useState(false);

	const save = async (updates: Partial<AppSettings>) => {
		setFailed(!(await saveSettings(updates)));
	};

	return (
		<div className={cn("space-y-3", className)}>
			<div>
				<p className="text-sm font-medium text-foreground">{tr("title")}</p>
				<p className="text-xs text-muted-foreground">{tr(`description.${provider}`)}</p>
			</div>
			{provider === "openrouter" ? (
				<OpenRouterRouting tr={tr} save={save} />
			) : (
				<HuggingFaceRouting tr={tr} save={save} />
			)}
			{failed && <p className="text-xs text-destructive">{tr("saveFailed")}</p>}
		</div>
	);
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;
type Save = (updates: Partial<AppSettings>) => Promise<void>;

function HuggingFaceRouting({ tr, save }: { readonly tr: Translate; readonly save: Save }) {
	const policy = useSettingsStore((s) => s.settings.huggingFaceRoutingPolicy);
	return (
		<div className="space-y-1">
			<Label htmlFor="hf-routing-policy">{tr("policy")}</Label>
			<select
				id="hf-routing-policy"
				className={selectClass}
				value={policy ?? ""}
				onChange={(e) =>
					void save({
						huggingFaceRoutingPolicy:
							HUGGINGFACE_POLICIES.find((p) => p === e.target.value) ?? "",
					})
				}
			>
				<option value="">{tr("policyDefault")}</option>
				{HUGGINGFACE_POLICIES.map((p) => (
					<option key={p} value={p}>
						{tr(`policies.${p}`)}
					</option>
				))}
			</select>
		</div>
	);
}

function OpenRouterRouting({ tr, save }: { readonly tr: Translate; readonly save: Save }) {
	const sort = useSettingsStore((s) => s.settings.openRouterSort);
	const denyData = useSettingsStore((s) => s.settings.openRouterDenyDataCollection === true);
	const zdr = useSettingsStore((s) => s.settings.openRouterZeroRetention === true);
	const saved = useSettingsStore((s) => s.settings.openRouterFallbackModels);
	const { models } = useProviderModelCatalog("openrouter");
	const [drafts, setDrafts] = useState<string[]>(() =>
		FALLBACK_SLOTS.map((_, i) => saved?.[i] ?? ""),
	);
	const invalid = drafts.map((d) => d.trim()).filter((d) => d && !isGatewayModelId(d));

	const saveFallbacks = () => {
		if (invalid.length) return;
		void save({ openRouterFallbackModels: cleanFallbackModels(drafts) });
	};

	return (
		<>
			<div className="space-y-1">
				<Label htmlFor="openrouter-sort">{tr("sort")}</Label>
				<select
					id="openrouter-sort"
					className={selectClass}
					value={sort ?? ""}
					onChange={(e) =>
						void save({ openRouterSort: OPENROUTER_SORTS.find((s) => s === e.target.value) ?? "" })
					}
				>
					<option value="">{tr("sortDefault")}</option>
					{OPENROUTER_SORTS.map((s) => (
						<option key={s} value={s}>
							{tr(`sorts.${s}`)}
						</option>
					))}
				</select>
			</div>
			<label className="flex items-center gap-2 text-sm text-foreground">
				<input
					type="checkbox"
					checked={denyData}
					onChange={(e) => void save({ openRouterDenyDataCollection: e.target.checked })}
					className="h-3.5 w-3.5"
				/>
				{tr("denyDataCollection")}
			</label>
			<label className="flex items-center gap-2 text-sm text-foreground">
				<input
					type="checkbox"
					checked={zdr}
					onChange={(e) => void save({ openRouterZeroRetention: e.target.checked })}
					className="h-3.5 w-3.5"
				/>
				{tr("zeroRetention")}
			</label>
			<div className="space-y-1">
				<Label>{tr("fallbacks")}</Label>
				<p className="text-xs text-muted-foreground">
					{tr("fallbacksHint", { count: MAX_FALLBACK_MODELS })}
				</p>
				<datalist id="openrouter-fallback-models">
					{models.map((m) => (
						<option key={m.value} value={m.value} />
					))}
				</datalist>
				<div className="grid gap-2 sm:grid-cols-3">
					{FALLBACK_SLOTS.map((slot, i) => (
						<Input
							key={slot}
							list="openrouter-fallback-models"
							value={drafts[i]}
							aria-label={tr("fallbackAria", { index: i + 1 })}
							placeholder={tr("fallbackPlaceholder")}
							onChange={(e) =>
								setDrafts((d) => d.map((v, j) => (j === i ? e.target.value : v)))
							}
							onBlur={saveFallbacks}
						/>
					))}
				</div>
				{invalid.map((id) => (
					<p key={id} className="text-xs text-destructive">
						{tr("invalidModel", { id })}
					</p>
				))}
			</div>
		</>
	);
}
