import { Lock, Palette } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { DecorId } from "../../lib/pixel-office-seasons";
import { AGENT_SKINS, type AgentSkin, skinUnlocked } from "../../lib/pixel-office-skins";
import type { PixelOfficeSettings } from "../../stores/pixel-office-store";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";

interface CosmeticsPanelProps {
	/** The decor the seasons earned. */
	readonly earned: readonly DecorId[];
	readonly hidden: readonly DecorId[];
	readonly skin: AgentSkin;
	readonly onChange: (updates: Partial<PixelOfficeSettings>) => void;
}

/**
 * The toolbar's cosmetics: how the characters are dressed (the neon skin is
 * a reward, locked until every season goal was met once), and which earned
 * decor the office shows.
 */
export function CosmeticsPanel({ earned, hidden, skin, onChange }: CosmeticsPanelProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const base = useId();

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					aria-label={t("pixelOffice:cosmetics.open")}
				>
					<Palette className="h-4 w-4" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-3" data-testid="cosmetics">
				<fieldset>
					<legend className="mb-1.5 text-sm font-semibold">
						{t("pixelOffice:cosmetics.skins")}
					</legend>
					<div className="flex flex-wrap gap-1">
						{AGENT_SKINS.map((id) => {
							const open = skinUnlocked(id, earned);
							return (
								<Button
									key={id}
									type="button"
									variant={id === skin ? "secondary" : "ghost"}
									size="sm"
									className="h-7 gap-1 px-2 text-xs"
									aria-pressed={id === skin}
									disabled={!open}
									onClick={() => onChange({ agentSkin: id })}
								>
									{!open && <Lock className="h-3 w-3" aria-hidden />}
									{t(`pixelOffice:cosmetics.skin.${id}`)}
								</Button>
							);
						})}
					</div>
					<p className="mt-1 text-3xs text-muted-foreground">
						{skinUnlocked("neon", earned)
							? t("pixelOffice:cosmetics.neonEarned")
							: t("pixelOffice:cosmetics.neonLocked")}
					</p>
				</fieldset>

				<fieldset className="mt-3">
					<legend className="mb-1.5 text-sm font-semibold">
						{t("pixelOffice:cosmetics.decor")}
					</legend>
					{earned.length === 0 ? (
						<p className="text-xs text-muted-foreground">{t("pixelOffice:seasons.noDecor")}</p>
					) : (
						<ul className="flex flex-col gap-1.5">
							{earned.map((id) => (
								<li key={id} className="flex items-center justify-between gap-2">
									<label htmlFor={`${base}-${id}`} className="text-xs">
										{t(`pixelOffice:seasons.decor.${id}`)}
									</label>
									<Switch
										id={`${base}-${id}`}
										checked={!hidden.includes(id)}
										onCheckedChange={(shown) =>
											onChange({
												hiddenDecor: shown
													? hidden.filter((other) => other !== id)
													: [...hidden, id],
											})
										}
									/>
								</li>
							))}
						</ul>
					)}
				</fieldset>
			</PopoverContent>
		</Popover>
	);
}
