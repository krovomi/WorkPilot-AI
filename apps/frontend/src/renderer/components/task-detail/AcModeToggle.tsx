import { AlignLeft, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

/** Les deux façons d'éditer la même liste : une puce par critère, ou le texte
 * brut d'avant. La liste est le mode par défaut ; le texte reste là pour ce
 * qu'elle fait mal — coller dix critères d'un ticket, en réordonner la moitié,
 * tout effacer d'un geste. */
export type AcEditorMode = "list" | "text";

interface AcModeToggleProps {
	readonly mode: AcEditorMode;
	readonly onChange: (mode: AcEditorMode) => void;
}

export function AcModeToggle({ mode, onChange }: AcModeToggleProps) {
	const { t } = useTranslation(["tasks"]);
	const options: { value: AcEditorMode; label: string; icon: typeof List }[] = [
		{ value: "list", label: t("tasks:metadata.acModeList"), icon: List },
		{ value: "text", label: t("tasks:metadata.acModeText"), icon: AlignLeft },
	];

	return (
		<fieldset
			className="inline-flex items-center rounded-md border border-border p-0.5"
			aria-label={t("tasks:metadata.acModeLabel")}
		>
			{options.map(({ value, label, icon: Icon }) => (
				<button
					key={value}
					type="button"
					onClick={() => onChange(value)}
					aria-pressed={mode === value}
					title={label}
					className={cn(
						"flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
						mode === value
							? "bg-muted text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<Icon className="h-3 w-3" aria-hidden="true" />
					{label}
				</button>
			))}
		</fieldset>
	);
}
