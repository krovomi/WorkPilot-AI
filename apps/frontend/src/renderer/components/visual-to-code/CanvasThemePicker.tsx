import { Paintbrush } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	CANVAS_PRESETS,
	type CanvasColorKey,
	type CanvasTheme,
	DEFAULT_CANVAS_PRESET,
	normalizeCanvasTheme,
} from "../../lib/canvas-themes";
import { BRICK_ACCENTS } from "../../lib/custom-bricks";
import {
	selectActiveArchitecture,
	useVisualToCodeStore,
} from "../../stores/visual-to-code-store";
import { Button } from "../ui";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ColorSwatches } from "./ColorSwatches";

const DARK_SURFACES = ["#0c0b0a", "#0b1020", "#111827", "#18181b", "#1a1817", "#1e1b2e"];
const LIGHT_SURFACES = ["#ffffff", "#f7f4f1", "#fbf8f3", "#f1f5f9", "#eef2ff"];
const LINES = ["#1f1d1b", "#1a2240", "#27272a", "#3f3f46", "#e2dacd", "#e5e7eb"];
const TEXTS = ["#f5f1ed", "#e6e9f5", "#ffffff", "#1c1917", "#2b2622", "#0f172a"];

/** What each colour row edits, with the swatches that make sense for it. */
const ROWS: { key: CanvasColorKey; labelKey: string; swatches: string[] }[] = [
	{ key: "flow", labelKey: "canvasColorFlow", swatches: BRICK_ACCENTS },
	{ key: "background", labelKey: "canvasColorBackground", swatches: [...DARK_SURFACES, ...LIGHT_SURFACES] },
	{ key: "card", labelKey: "canvasColorCard", swatches: [...DARK_SURFACES, ...LIGHT_SURFACES] },
	{ key: "border", labelKey: "canvasColorBorder", swatches: LINES },
	{ key: "grid", labelKey: "canvasColorGrid", swatches: LINES },
	{ key: "text", labelKey: "canvasColorText", swatches: TEXTS },
];

/**
 * The canvas' colours, per architecture: a preset (the app's own theme by
 * default, a few accents, two full palettes) and any colour picked by hand
 * on top of it — background, cards, their borders, the grid, the text and the
 * connectors. A block or a single connection can also be given its own colour
 * from the inspector.
 */
export function CanvasThemePicker() {
	const { t } = useTranslation("visualProgramming");
	const architecture = useVisualToCodeStore(selectActiveArchitecture);
	const updateArchitecture = useVisualToCodeStore((s) => s.updateArchitecture);
	const theme = normalizeCanvasTheme(architecture?.theme) ?? {};
	const preset = theme.preset ?? DEFAULT_CANVAS_PRESET;

	const save = (next: CanvasTheme) => {
		if (!architecture) return;
		updateArchitecture(architecture.id, { theme: normalizeCanvasTheme(next) });
	};

	const setColor = (key: CanvasColorKey, value: string | undefined) => {
		const colors = { ...theme.colors };
		if (value) colors[key] = value;
		else delete colors[key];
		save({ ...theme, colors });
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					disabled={!architecture}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("canvasColors", "Couleurs du canvas")}
				>
					<Paintbrush className="h-3.5 w-3.5" />
					<span className="hidden xl:inline">
						{t("canvasColorsShort", "Couleurs")}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 space-y-3">
				<div>
					<p className="text-xs font-semibold">
						{t("canvasColors", "Couleurs du canvas")}
					</p>
					<p className="mt-0.5 text-3xs text-muted-foreground">
						{t(
							"canvasColorsHint",
							"Propres à cette architecture. Un bloc ou une connexion peut aussi avoir sa couleur, depuis l'inspecteur.",
						)}
					</p>
				</div>
				<div className="grid grid-cols-4 gap-1.5">
					{CANVAS_PRESETS.map((p) => (
						<button
							key={p.id}
							type="button"
							onClick={() => save({ preset: p.id })}
							aria-pressed={preset === p.id}
							className="flex flex-col items-center gap-1 rounded-md border border-transparent p-1.5 text-3xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:border-border aria-pressed:bg-accent aria-pressed:text-foreground"
						>
							<span
								className="h-5 w-5 rounded-full border border-black/10"
								style={{
									background: `linear-gradient(135deg, ${p.tokens.background ?? "#0c0b0a"} 50%, ${p.swatch} 50%)`,
								}}
							/>
							<span className="max-w-full truncate">{t(p.labelKey)}</span>
						</button>
					))}
				</div>
				{ROWS.map((row) => (
					<div key={row.key}>
						<span className="mb-1 block text-2xs font-medium text-muted-foreground">
							{t(row.labelKey)}
						</span>
						<ColorSwatches
							value={theme.colors?.[row.key]}
							onChange={(value) => setColor(row.key, value)}
							label={t(row.labelKey)}
							swatches={row.swatches}
							allowAuto
						/>
					</div>
				))}
				<Button
					size="sm"
					variant="outline"
					className="w-full text-xs"
					onClick={() => save({})}
				>
					{t("canvasColorsReset", "Revenir aux couleurs par défaut")}
				</Button>
			</PopoverContent>
		</Popover>
	);
}
