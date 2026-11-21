import { useTranslation } from "react-i18next";
import {
	FAMILY_SHIRTS,
	PROVIDER_FAMILIES,
	type ProviderFamily,
} from "../../lib/pixel-office-providers";
import type { PixelAgent } from "../../stores/pixel-office-store";

/** The provider families at work in the room, with their shirt colour. */
export function ProviderLegend({ agents }: { readonly agents: readonly PixelAgent[] }) {
	const { t } = useTranslation(["pixelOffice"]);
	const present = new Set<ProviderFamily>();
	for (const agent of agents) if (agent.providerFamily) present.add(agent.providerFamily);
	const families = PROVIDER_FAMILIES.filter((family) => present.has(family));
	if (families.length === 0) return null;
	return (
		<ul
			className="flex items-center gap-2"
			aria-label={t("pixelOffice:providers.legend")}
		>
			{families.map((family) => (
				<li
					key={family}
					data-testid={`provider-${family}`}
					className="flex items-center gap-1 text-3xs font-mono text-muted-foreground"
				>
					<span
						className="inline-block h-2.5 w-2.5 rounded-sm border border-black/30"
						style={{ background: FAMILY_SHIRTS[family] }}
						aria-hidden
					/>
					{t(`pixelOffice:providers.${family}`)}
				</li>
			))}
		</ul>
	);
}
