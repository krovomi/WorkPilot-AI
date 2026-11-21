import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
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
	providerSupportsThinking,
	THINKING_LEVELS,
} from "@shared/constants/models";
import type { ThinkingLevel } from "@shared/types/settings";
import type { PageLlmOverride } from "@shared/utils/page-llm";
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
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveSettings, useSettingsStore } from "../stores/settings-store";
import { useShallow } from "zustand/react/shallow";
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
	const { settings, profiles } = useSettingsStore(
		useShallow((s) => ({
			settings: s.settings,
			profiles: s.profiles,
		})),
	);
	const [providers, setProviders] = useState<CanonicalProvider[]>([]);
	const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>(
		{},
	);
	const [isOpen, setIsOpen] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const fieldId = useId();

	useEffect(() => {
		let cancelled = false;
		// getStaticProviders does not reject: each check it makes catches its own failure.
		void getStaticProviders(
			profiles,
			settings as unknown as Record<string, unknown>,
		).then((data) => {
			if (cancelled) return;
			setProviders(data.providers);
			setProviderStatus(data.status);
		});
		return () => {
			cancelled = true;
		};
	}, [profiles, settings]);

	const pageId = isPageLlmPage(page) ? page : null;
	const resolved = useMemo(
		() => (pageId ? resolvePageLlm(settings, pageId) : null),
		[pageId, settings],
	);

	const { models } = useProviderModelCatalog(resolved?.provider || "");

	if (!resolved || !pageId) return null;

	const override = settings.pageLlmOverrides?.[pageId] ?? {};
	/** What the page would use for this field if it named nothing for it. */
	const inheritedFor = (field: keyof PageLlmOverride) =>
		resolvePageLlm(
			{
				...settings,
				pageLlmOverrides: {
					...settings.pageLlmOverrides,
					[pageId]: { ...override, [field]: undefined },
				},
			},
			pageId,
		);
	// Les tables de capacités sont indexées sur « anthropic », le backend sur
	// « claude » : le résolveur rend la seconde forme, il faut demander la
	// première — sinon l'effort disparaît de la page sur le fournisseur qui le
	// supporte le mieux.
	const capabilityProvider =
		resolved.provider === "claude" ? "anthropic" : resolved.provider;
	const supportsThinking =
		!capabilityProvider || providerSupportsThinking(capabilityProvider);

	const providerName = (id: string) =>
		providers.find((p) => normalizeProviderId(p.name) === id)?.label ||
		id ||
		t("dialogs:pageLlm.providerUnset");
	const modelName = (value: string) =>
		models.find((m) => m.value === value)?.label ?? value;
	const providerLabel = providerName(resolved.provider);
	const modelLabel = modelName(resolved.model);
	// Un modèle de page que le résolveur a écarté (il appartient à un autre
	// fournisseur) ne s'affiche pas comme le choix de la page : c'est l'héritage
	// qui s'applique, et c'est lui que la liste doit montrer.
	const pageModel =
		resolved.modelSource === "page" ? override.model : undefined;

	// Le fournisseur que la page suit sans surcharge, sous le nom de la liste :
	// un modèle choisi tant que la page n'en nomme aucun l'épingle.
	const globalProvider = normalizeProviderId(settings.selectedProvider);
	const inheritedProvider =
		providers.find((p) => normalizeProviderId(p.name) === globalProvider)
			?.name ?? (globalProvider === "claude" ? "anthropic" : globalProvider);

	const patch = async (
		field: "provider" | "model" | "thinking",
		value: string,
	) => {
		const next = setPageLlmOverride(
			settings.pageLlmOverrides,
			pageId,
			{
				[field]:
					value === INHERIT
						? undefined
						: field === "thinking"
							? (value as ThinkingLevel)
							: value,
			},
			inheritedProvider,
		);
		await save(next);
	};

	const reset = async () => {
		// Reset is enabled only when this page has an override stored.
		const next = { ...settings.pageLlmOverrides };
		delete next[pageId];
		await save(next);
	};

	const save = async (pageLlmOverrides: Record<string, PageLlmOverride>) => {
		setSaveFailed(false);
		if (!(await saveSettings({ pageLlmOverrides }))) setSaveFailed(true);
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
						<Badge variant="secondary" className="h-4 px-1 text-3xs">
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
					<Label htmlFor={`${fieldId}-provider`} className="text-xs text-muted-foreground">
						{t("dialogs:providerSelector.label")}
					</Label>
					<Select
						value={override.provider ?? INHERIT}
						onValueChange={(value) => patch("provider", value)}
					>
						<SelectTrigger id={`${fieldId}-provider`} className="h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent searchable>
							<SelectItem value={INHERIT}>
								{t("dialogs:pageLlm.inheritProvider", {
									provider: providerName(globalProvider),
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
					<Label htmlFor={`${fieldId}-model`} className="text-xs text-muted-foreground">
						{t("dialogs:pageLlm.model")}
					</Label>
					<Select
						value={pageModel ?? INHERIT}
						onValueChange={(value) => patch("model", value)}
					>
						<SelectTrigger id={`${fieldId}-model`} className="h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent searchable>
							<SelectItem value={INHERIT}>
								{t("dialogs:pageLlm.inheritModel", {
									model: modelName(inheritedFor("model").model),
								})}
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
						<Label htmlFor={`${fieldId}-effort`} className="text-xs text-muted-foreground">
							{t("dialogs:pageLlm.effortLabel")}
						</Label>
						<Select
							value={override.thinking ?? INHERIT}
							onValueChange={(value) => patch("thinking", value)}
						>
							<SelectTrigger id={`${fieldId}-effort`} className="h-9">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={INHERIT}>
									{t("dialogs:pageLlm.inheritEffort", {
										effort: t(
											`dialogs:pageLlm.effort.${inheritedFor("thinking").thinking}`,
										),
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

				{saveFailed && (
					<p role="alert" className="text-xs text-destructive">
						{t("dialogs:pageLlm.saveFailed")}
					</p>
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
