/**
 * Small controls of the API Explorer's request panel. Split out of
 * RequestPanel.tsx.
 */
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface CustomSelectOption {
	value: string;
	label: string;
}

export interface CustomSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: CustomSelectOption[];
	className?: string;
	/** Lets a `<label htmlFor>` name the select. */
	id?: string;
}

export function CustomSelect({
	value,
	onChange,
	options,
	className,
	id,
}: CustomSelectProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const selected = options.find((o) => o.value === value);

	useEffect(() => {
		if (!open) return;
		function handler(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			)
				setOpen(false);
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={containerRef} className={`relative ${className ?? ""}`}>
			<button
				id={id}
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex items-center justify-between w-full bg-card border border-[var(--color-border)] rounded-md px-3 py-2 text-[length:inherit] text-foreground hover:border-primary/40 focus:outline-none focus:border-[var(--color-accent)] cursor-pointer transition-colors"
			>
				<span>{selected?.label ?? value}</span>
				<ChevronDown
					size={14}
					className={`text-muted-foreground shrink-0 ml-2 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open && (
				<div
					className="absolute z-50 top-full left-0 min-w-full w-max mt-1 bg-[var(--card)] border border-[var(--color-border)] rounded-md shadow-xl overflow-hidden"
					style={{ backdropFilter: "none" }}
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							className={`flex items-center gap-2 w-full px-3 py-2 text-[length:inherit] text-left transition-colors hover:bg-card ${
								opt.value === value
									? "text-foreground bg-card"
									: "text-muted-foreground"
							}`}
						>
							{opt.value === value && (
								<Check
									size={13}
									className="shrink-0 text-[var(--color-primary)]"
								/>
							)}
							{opt.value !== value && <span className="w-[13px] shrink-0" />}
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
