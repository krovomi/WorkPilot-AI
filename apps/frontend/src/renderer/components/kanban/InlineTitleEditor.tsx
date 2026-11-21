import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const stop = (e: SyntheticEvent) => e.stopPropagation();

interface InlineTitleEditorProps {
	initial: string;
	/**
	 * The new title, or null when nothing changed (Escape, an empty or
	 * identical title). `byKey` is true for Enter and Escape: the focus then
	 * goes back to the card.
	 */
	onDone: (title: string | null, byKey: boolean) => void;
}

/**
 * The card's title as a text box (double-click on the title, or F2): Enter
 * or leaving it saves, Escape keeps the old title.
 */
export function InlineTitleEditor({ initial, onDone }: InlineTitleEditorProps) {
	const { t } = useTranslation(["tasks"]);
	const [value, setValue] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	const done = useRef(false);

	useEffect(() => {
		const box = input.current as HTMLInputElement;
		box.focus();
		box.select();
	}, []);

	const finish = (save: boolean, byKey: boolean) => {
		if (done.current) return;
		done.current = true;
		const title = value.trim();
		onDone(save && title && title !== initial ? title : null, byKey);
	};

	return (
		<input
			ref={input}
			value={value}
			aria-label={t("tasks:kanban.rename.label")}
			className="mt-1 w-full rounded border border-ring bg-background px-1 py-0.5 text-sm font-semibold text-foreground outline-none"
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				finish(e.key === "Enter", true);
			}}
			onBlur={() => finish(true, false)}
			// The card opens on a click and drags on a press: not from here.
			onClick={stop}
			onDoubleClick={stop}
			onPointerDown={stop}
			onMouseDown={stop}
		/>
	);
}
