import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConfiguredProviders } from "../hooks/useConfiguredProviders";
import { useProviderContext } from "./ProviderContext";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const AUTO = "__auto__";

/**
 * Which provider the usage badges next to it observe.
 *
 * This is all that is left of the header's "Fournisseur IA" list, and it is
 * deliberately a smaller thing: it decides what the badges show, never what a
 * task runs on. Each task owns its engine; the default provider for new tasks
 * lives in Settings → Agent. "Automatic" follows the tasks in progress, so the
 * badge shows the account that is being spent right now.
 */
export function UsageLensSelector() {
	const { t } = useTranslation(["common"]);
	const { usageProvider, usageProviderChoice, setUsageProviderChoice, runningProviders } =
		useProviderContext();
	const { providers } = useConfiguredProviders();

	const labelOf = (name: string) =>
		providers.find((p) => p.name === name)?.label ?? name;
	// Running providers first: they are the ones a person looks for here.
	const ordered = [
		...providers.filter((p) => runningProviders.includes(p.name)),
		...providers.filter((p) => !runningProviders.includes(p.name)),
	];
	if (usageProviderChoice && !providers.some((p) => p.name === usageProviderChoice)) {
		ordered.push({ name: usageProviderChoice, label: usageProviderChoice });
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div>
					<Select
						value={usageProviderChoice ?? AUTO}
						onValueChange={(value) =>
							setUsageProviderChoice(value === AUTO ? null : value)
						}
					>
						<SelectTrigger
							className="h-8 gap-1.5 px-2 text-xs"
							aria-label={t("common:usage.lensAria")}
						>
							<Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value={AUTO}>
								{usageProvider
									? t("common:usage.lensAutoWith", {
											provider: labelOf(usageProvider),
										})
									: t("common:usage.lensAuto")}
							</SelectItem>
							{ordered.map((p) => (
								<SelectItem key={p.name} value={p.name}>
									{runningProviders.includes(p.name)
										? t("common:usage.lensRunning", { provider: p.label })
										: p.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				{t("common:usage.lensTooltip")}
			</TooltipContent>
		</Tooltip>
	);
}
