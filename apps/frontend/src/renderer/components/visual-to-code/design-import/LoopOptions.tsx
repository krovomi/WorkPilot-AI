import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RENDER_LOOP_CHOICES } from "../../../../shared/constants/design-render-loop";
import type { RenderLoopOptions } from "../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";
import { percent } from "./IterationPanel";

type NumberOption = "maxIterations" | "threshold" | "maxTokens" | "maxCostUsd";
const NUMBERS: NumberOption[] = ["maxIterations", "threshold", "maxTokens", "maxCostUsd"];

/** How a choice reads in the page, per option. */
function useValueLabel() {
	const { t } = useTranslation("designToCode");
	return (key: NumberOption, value: number): string => {
		switch (key) {
			case "maxIterations":
				return t("loopOptions.iterationsValue", { count: value });
			case "threshold":
				return t("loop.score", { score: percent(value) });
			case "maxTokens":
				return t("loopOptions.tokensValue", { value: value / 1000 });
			default:
				return t("loopOptions.costValue", { value });
		}
	};
}

/**
 * The render loop's limits and passes, in the composer (#379). The page only
 * offers choices: the main process and the runner bound every value again.
 */
export function LoopOptions({ disabled }: { disabled: boolean }) {
	const { t } = useTranslation("designToCode");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const options = useDesignToCodeStore((s) => s.loopOptions);
	const setLoopOptions = useDesignToCodeStore((s) => s.setLoopOptions);
	const label = useValueLabel();

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	// The fix sends the passes' findings back: without a pass it has none.
	const noPass = !options.responsive && !options.states;
	const toggle = (key: "responsive" | "states" | "fixPasses", off = false) => (
		<label className="di-pick">
			<input
				type="checkbox"
				checked={options[key] && !off}
				disabled={off}
				data-testid={`design-loop-${key}`}
				onChange={(event) => setLoopOptions({ [key]: event.target.checked } as Partial<RenderLoopOptions>)}
			/>
			{t(`loopOptions.${key}`)}
		</label>
	);

	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				className="di-pick"
				data-open={open}
				disabled={disabled}
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				data-testid="design-loop-options"
			>
				{t("loopOptions.button")}
				<b>
					{t("loopOptions.summary", {
						iterations: options.maxIterations,
						threshold: percent(options.threshold),
					})}
				</b>
				<ChevronDown className="h-3 w-3" />
			</button>
			{open && (
				<div className="di-stackpop" role="dialog" aria-label={t("loopOptions.button")}>
					{NUMBERS.map((key) => (
						<label key={key} className="di-pick">
							{t(`loopOptions.${key}`)}
							<select
								value={options[key]}
								data-testid={`design-loop-${key}`}
								onChange={(event) => setLoopOptions({ [key]: Number(event.target.value) })}
							>
								{RENDER_LOOP_CHOICES[key].map((value) => (
									<option key={value} value={value}>
										{label(key, value)}
									</option>
								))}
							</select>
						</label>
					))}
					<div className="di-muted text-2xs">{t("loopOptions.budgetHint")}</div>
					{toggle("responsive")}
					{toggle("states")}
					{toggle("fixPasses", noPass)}
				</div>
			)}
		</div>
	);
}
