import { Check, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BRICK_ACCENTS, isAccent } from "../../lib/custom-bricks";

interface ColorSwatchesProps {
	/** `#rrggbb`, or undefined when the colour is automatic. */
	value: string | undefined;
	/** `undefined` returns to the automatic colour. */
	onChange: (value: string | undefined) => void;
	/** Accessible name of the group ("Connectors", "Background"…). */
	label: string;
	swatches?: string[];
	/** Offer "automatic" (no colour of one's own). */
	allowAuto?: boolean;
	/** Colour the picker opens on when there is no value. */
	fallback?: string;
}

/**
 * A row of colour swatches, a free colour picker and, when the colour can be
 * left to the theme, a way back to automatic. Shared by the brick editor, the
 * inspector and the canvas colours, so every colour on the canvas is picked
 * the same way.
 */
export function ColorSwatches({
	value,
	onChange,
	label,
	swatches = BRICK_ACCENTS,
	allowAuto = false,
	fallback = "#f97316",
}: ColorSwatchesProps) {
	const { t } = useTranslation("visualProgramming");
	const current = isAccent(value) ? value.toLowerCase() : undefined;
	return (
		<fieldset className="flex flex-wrap items-center gap-1.5" aria-label={label}>
			{allowAuto ? (
				<button
					type="button"
					onClick={() => onChange(undefined)}
					aria-pressed={current === undefined}
					title={t("colorAuto", "Automatique")}
					aria-label={t("colorAuto", "Automatique")}
					className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-muted-foreground ring-offset-2 ring-offset-background hover:text-foreground aria-pressed:ring-2 aria-pressed:ring-foreground"
				>
					<RotateCcw className="h-3 w-3" />
				</button>
			) : null}
			{swatches.map((swatch) => (
				<button
					key={swatch}
					type="button"
					onClick={() => onChange(swatch)}
					aria-label={swatch}
					aria-pressed={current === swatch.toLowerCase()}
					className="flex h-6 w-6 items-center justify-center rounded-full border border-black/10 ring-offset-2 ring-offset-background transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-foreground"
					style={{ backgroundColor: swatch }}
				>
					{current === swatch.toLowerCase() ? (
						<Check className="h-3 w-3 mix-blend-difference text-white" />
					) : null}
				</button>
			))}
			<input
				type="color"
				value={current ?? fallback}
				onChange={(e) => onChange(e.target.value)}
				aria-label={t("brickCustomColor", "Autre couleur")}
				title={t("brickCustomColor", "Autre couleur")}
				className="h-6 w-8 cursor-pointer rounded border bg-transparent"
			/>
		</fieldset>
	);
}
