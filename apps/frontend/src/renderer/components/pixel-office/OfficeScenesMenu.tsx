import { MessageSquareText } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";

interface OfficeScenesMenuProps {
	readonly enabled: boolean;
	readonly ai: boolean;
	readonly onChange: (changes: { narratives?: boolean; narrativesAi?: boolean }) => void;
}

/**
 * The scenes' switches: show them, and have the page's model write them
 * (the provider and model are the page's own, chosen above the view). The
 * second is off until the person turns it on, and says what the model gets.
 */
export function OfficeScenesMenu({ enabled, ai, onChange }: OfficeScenesMenuProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const showId = useId();
	const aiId = useId();
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 w-8 p-0"
					aria-label={t("pixelOffice:narratives.settings")}
				>
					<MessageSquareText className={`h-4 w-4 ${enabled ? "" : "opacity-40"}`} />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-3">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor={showId}>{t("pixelOffice:narratives.show")}</Label>
					<Switch
						id={showId}
						checked={enabled}
						onCheckedChange={(checked) => onChange({ narratives: checked })}
					/>
				</div>
				<div className="mt-3 flex items-center justify-between gap-3">
					<Label htmlFor={aiId}>{t("pixelOffice:narratives.ai")}</Label>
					<Switch
						id={aiId}
						checked={ai}
						disabled={!enabled}
						onCheckedChange={(checked) => onChange({ narrativesAi: checked })}
					/>
				</div>
				<p className="mt-2 text-xs text-muted-foreground">
					{t("pixelOffice:narratives.aiHelp")}
				</p>
			</PopoverContent>
		</Popover>
	);
}
