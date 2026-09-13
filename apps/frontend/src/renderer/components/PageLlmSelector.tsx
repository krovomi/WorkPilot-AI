/**
 * Le choix « provider × LLM × effort » de la page courante.
 *
 * Il vit à côté de la liste « Fournisseur IA », et il n'en est pas un doublon :
 * cette liste dit avec quoi l'application travaille, celui-ci dit avec quoi
 * *cette page* travaille. Trois crans, chacun avec une entrée « comme les
 * réglages » — c'est cette entrée, et non une valeur recopiée, qui fait qu'un
 * changement de fournisseur global bouge les pages qui n'ont rien demandé.
 *
 * Le composant n'affiche rien sur une page qui ne sait pas exécuter le choix
 * (cf. `PAGE_LLM_FEATURES`) : un sélecteur qui promet ce que le runner ignore
 * est pire que pas de sélecteur.
 */

import {
	getModelsForProvider,
	providerSupportsThinking,
	THINKING_LEVELS,
} from "@shared/constants/models";
import type { ThinkingLevel } from "@shared/types/settings";
import type { PageLlmPage } from "@shared/utils/page-llm";
import {
	isPageLlmPage,
	normalizeProviderId,
	resolvePageLlm,
	setPageLlmOverride,
} from "@shared/utils/page-llm";
import type { CanonicalProvider } from "@shared/utils/providers";
import { getStaticProviders } from "@shared/utils/providers";
import { RotateCcw, Sparkles } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveSettings, useSettingsStore } from "../stores/settings-store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

/** Valeur de `Select` qui signifie « rien de choisi ici ». */
const INHERIT = "__inherit__";

interface PageLlmSelectorProps {
	/** La vue active (un `SidebarView`). */
	page: string | undefined;
}

export const PageLlmSelector: React.FC<PageLlmSelectorProps> = ({ page }) => {
	const { t } = useTranslation(["dialogs", "common"]);
	const { settings, profiles } = useSettingsStore();
	const [providers, setProviders] = useState<CanonicalProvider[]>([]);
	const [providerStatus, setProviderStatus] = useState<
		Record<string, boolean>
	>({});
	const [isOpen, setIsOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getStaticProviders(profiles, settings as unknown as Record<string, unknown>)
			.then((data) => {
				if (cancelled) return;
				setProviders(data.providers);
				setProviderStatus(data.status);
			})
			.catch(() => {
				if (!cancelled) setProviders([]);
			});
		return () => {
			cancelled = true;
		};
	}, [profiles, settings]);

	const resolved = useMemo(
		() =>
			isPageLlmPage(page) ? resolvePageLlm(settings, page as PageLlmPage) : null,
		[page, settings],
	);

	if (!resolved || !isPageLlmPage(page)) return null;

	const override = settings.pageLlmOverrides?.[page] ?? {};
	const models = getModelsForProvider(resolved.provider || "anthropic");
	// Les tables de capacités sont indexées sur « anthropic », le backend sur
	// « claude » : le résolveur rend la seconde forme, il faut demander la
	// première — sinon l'effort disparaît de la page sur le fournisseur qui le
	// supporte le mieux.
	const capabilityProvider =
		resolved.provider === "claude" ? "anthropic" : resolved.provider;
	const supportsThinking =
		!capabilityProvider || providerSupportsThinking(capabilityProvider);

	const providerLabel =
		providers.find(
			(p) => normalizeProviderId(p.name) === resolved.provider,
		)?.label ||
		resolved.provider ||
		t("dialogs:pageLlm.providerUnset");
	const modelLabel =
		models.find((m) => m.value === resolved.model)?.label ?? resolved.model;

	const patch = async (
		field: "provider" | "model" | "thinking",
		value: string,
	) => {
		const next = setPageLlmOverride(
			settings.pageLlmOverrides,
			page as PageLlmPage,
			{
				[field]:
					value === INHERIT
						? undefined
						: field === "thinking"
							? (value as ThinkingLevel)
							: value,
			},
		);
		await saveSettings({ pageLlmOverrides: next });
	};

	const reset = async () => {
		const next = { ...(settings.pageLlmOverrides ?? {}) };
		delete next[page];
		await saveSettings({ pageLlmOverrides: next });
	};

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
					title={t("dialogs:pageLlm.tooltip")}
				>
					<Sparkles className="h-3.5 w-3.5 shrink-0" />
					<span className="truncate max-w-64">
						{t("dialogs:pageLlm.summary", {
							provider: providerLabel,
							model: modelLabel,
							effort: t(`dialogs:pageLlm.effort.${resolved.thinking}`),
						})}
					</span>
					{resolved.hasOverride && (
						<Badge variant="secondary" className="h-4 px-1 text-[10px]">
							{t("dialogs:pageLlm.pageBadge")}
						</Badge>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 space-y-3">
				<div className="space-y-1">
					<p className="text-sm font-medium">{t("dialogs:pageLlm.title")}</p>
					<p className="text-xs text-muted-foreground">
						{t("dialogs:pageLlm.description")}
					</p>
				</div>

				{/* Fournisseur */}
				<div className="space-y-1">
					<Label className="text-xs text-muted-foreground">
						{t("dialogs:providerSelector.label")}
					</Label>
					<Select
						value={override.provider ?? INHERIT}
						onValueChange={(value) => patch("provider", value)}
					>
						<SelectTrigger className="h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>
								{t("dialogs:pageLlm.inheritProvider", {
									provider: providerLabel,
								})}
							</SelectItem>
							{providers.map((p) => (
								<SelectItem
									key={p.name}
									value={p.name}
									disabled={providerStatus[p.name] === false}
								>
									{p.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Modèle */}
				<div className="space-y-1">
					<Label className="text-xs text-muted-foreground">
						{t("dialogs:pageLlm.model")}
					</Label>
					<Select
						value={override.model ?? INHERIT}
						onValueChange={(value) => patch("model", value)}
					>
						<SelectTrigger className="h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>
								{t("dialogs:pageLlm.inheritModel", { model: modelLabel })}
							</SelectItem>
							{models.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Effort — masqué quand le fournisseur n'a pas de réflexion étendue */}
				{supportsThinking && (
					<div className="space-y-1">
						<Label className="text-xs text-muted-foreground">
							{t("dialogs:pageLlm.effortLabel")}
						</Label>
						<Select
							value={override.thinking ?? INHERIT}
							onValueChange={(value) => patch("thinking", value)}
						>
							<SelectTrigger className="h-9">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={INHERIT}>
									{t("dialogs:pageLlm.inheritEffort", {
										effort: t(`dialogs:pageLlm.effort.${resolved.thinking}`),
									})}
								</SelectItem>
								{THINKING_LEVELS.map((level) => (
									<SelectItem key={level.value} value={level.value}>
										{t(`dialogs:pageLlm.effort.${level.value}`)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<div className="flex items-center justify-between pt-1">
					<p className="text-xs text-muted-foreground">
						{resolved.hasOverride
							? t("dialogs:pageLlm.originPage")
							: t("dialogs:pageLlm.originSettings")}
					</p>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1 text-xs"
						onClick={reset}
						disabled={!resolved.hasOverride}
					>
						<RotateCcw className="h-3 w-3" />
						{t("dialogs:pageLlm.reset")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
};

export default PageLlmSelector;
