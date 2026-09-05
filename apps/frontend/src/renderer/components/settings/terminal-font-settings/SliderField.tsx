import { Minus, Plus } from "lucide-react";
import { SLIDER_INPUT_CLASSES } from "../../../lib/terminal-font-constants";
import { cn } from "../../../lib/utils";
import { Label } from "../../ui/label";

interface SliderFieldStepper {
	readonly onDecrease: () => void;
	readonly onIncrease: () => void;
	readonly decreaseTitle: string;
	readonly increaseTitle: string;
	readonly decreaseDisabled: boolean;
	readonly increaseDisabled: boolean;
}

interface SliderFieldProps {
	readonly label: string;
	readonly description: string;
	/** Formatted current value, shown in the chip next to the label */
	readonly valueLabel: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly minLabel: string;
	readonly maxLabel: string;
	readonly ariaValueText: string;
	readonly onChange: (value: number) => void;
	readonly stepper?: SliderFieldStepper;
}

const STEPPER_BUTTON_CLASSES = cn(
	"inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
	"hover:bg-accent text-muted-foreground hover:text-foreground",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	"disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
);

/**
 * One labelled range control: name, current value, description, track and bounds.
 *
 * Font size, line height, letter spacing and scrollback all render the same five
 * pieces; four hand-written copies of them is how the value chip ended up in a
 * different place on each panel.
 */
export function SliderField({
	label,
	description,
	valueLabel,
	value,
	min,
	max,
	step,
	minLabel,
	maxLabel,
	ariaValueText,
	onChange,
	stepper,
}: SliderFieldProps) {
	return (
		<div className="space-y-2.5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Label className="text-sm font-medium text-foreground">{label}</Label>
				<div className="flex items-center gap-1.5">
					<span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs tabular-nums text-foreground">
						{valueLabel}
					</span>
					{stepper && (
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								onClick={stepper.onDecrease}
								disabled={stepper.decreaseDisabled}
								className={STEPPER_BUTTON_CLASSES}
								title={stepper.decreaseTitle}
								aria-label={stepper.decreaseTitle}
							>
								<Minus className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								onClick={stepper.onIncrease}
								disabled={stepper.increaseDisabled}
								className={STEPPER_BUTTON_CLASSES}
								title={stepper.increaseTitle}
								aria-label={stepper.increaseTitle}
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						</div>
					)}
				</div>
			</div>

			<p className="text-xs leading-relaxed text-muted-foreground">
				{description}
			</p>

			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(parseFloat(event.target.value))}
				aria-label={label}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={value}
				aria-valuetext={ariaValueText}
				className={cn(...SLIDER_INPUT_CLASSES)}
			/>

			<div className="flex justify-between text-[11px] text-muted-foreground">
				<span>{minLabel}</span>
				<span>{maxLabel}</span>
			</div>
		</div>
	);
}
