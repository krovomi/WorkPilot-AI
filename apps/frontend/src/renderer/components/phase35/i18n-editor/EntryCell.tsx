/**
 * One translation, in one locale, editable in place.
 *
 * Two states matter and the UI keeps them apart, because the files do:
 * a key **absent** from this locale is untranslated, and a key present with an
 * empty string is a deliberate blank. An absent value therefore renders as an
 * invitation rather than an empty box — otherwise the only way to tell the two
 * apart would be to open the JSON.
 */

import { Plus, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";

interface EntryCellProps {
	value: string | null;
	locale: string;
	entryKey: string;
	isDirty: boolean;
	/** The cell whose interpolation variables the others are compared to. */
	isReference: boolean;
	/** This value's variables diverge from the reference's. */
	hasMismatch: boolean;
	onChange: (value: string) => void;
	onRevert: () => void;
	disabled?: boolean;
}

/** Grow the box to its content, so a long string is read without scrolling it. */
function autoSize(el: HTMLTextAreaElement | null) {
	if (!el) return;
	el.style.height = "auto";
	el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}

export function EntryCell({
	value,
	locale,
	entryKey,
	isDirty,
	isReference,
	hasMismatch,
	onChange,
	onRevert,
	disabled,
}: EntryCellProps) {
	const { t } = useTranslation("phase35");
	const ref = useRef<HTMLTextAreaElement>(null);
	// A missing value stays missing until the user asks to fill it: writing ""
	// on focus would silently turn "untranslated" into "translated as blank".
	const [filling, setFilling] = useState(false);

	useEffect(() => {
		autoSize(ref.current);
	}, []);

	if (value === null && !filling) {
		return (
			<button
				type="button"
				disabled={disabled}
				onClick={() => setFilling(true)}
				className={cn(
					"group flex w-full items-center gap-1.5 rounded border border-dashed",
					"px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors",
					"hover:border-primary/60 hover:text-foreground",
					"disabled:pointer-events-none disabled:opacity-50",
				)}
				aria-label={t("i18nEditor.addTranslation", { locale, key: entryKey })}
			>
				<Plus className="h-3 w-3 shrink-0" />
				<span className="truncate">{t("i18nEditor.missingValue")}</span>
			</button>
		);
	}

	return (
		<div className="relative">
			<textarea
				ref={ref}
				value={value ?? ""}
				rows={1}
				disabled={disabled}
				spellCheck={false}
				aria-label={t("i18nEditor.valueFor", { locale, key: entryKey })}
				aria-invalid={hasMismatch || undefined}
				onChange={(e) => {
					autoSize(e.currentTarget);
					onChange(e.target.value);
				}}
				onKeyDown={(e) => {
					// Escape puts the cell back to what was loaded — the cheap undo
					// people reach for before they look for a button.
					if (e.key === "Escape" && isDirty) {
						e.preventDefault();
						e.stopPropagation();
						onRevert();
					}
				}}
				// biome-ignore lint/a11y/noAutofocus: only when the user just asked to fill this cell
				autoFocus={filling}
				className={cn(
					"w-full resize-none rounded border bg-background px-2 py-1.5 text-xs",
					"focus:outline-none focus:ring-1 focus:ring-ring",
					isDirty && "border-l-2 border-l-primary bg-primary/5",
					hasMismatch && !isReference && "border-amber-500/60",
				)}
			/>
			{isDirty && (
				<button
					type="button"
					onClick={onRevert}
					disabled={disabled}
					title={t("i18nEditor.revertCell")}
					aria-label={t("i18nEditor.revertCell")}
					className={cn(
						"absolute right-1 top-1 rounded p-0.5 text-muted-foreground",
						"opacity-0 transition-opacity hover:text-foreground",
						"focus:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100",
					)}
				>
					<Undo2 className="h-3 w-3" />
				</button>
			)}
		</div>
	);
}
