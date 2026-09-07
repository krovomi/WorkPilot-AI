import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

interface Suggestion {
	value: string;
	source: string;
}

/** A choice must come from the official library, never from arbitrary text. */
export function OfficialModelSearch({
	onSelect,
	onClose,
}: {
	onSelect: (model: string) => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("tasks");
	const [query, setQuery] = useState("");
	const [answer, setAnswer] = useState<{
		query: string;
		models: Suggestion[];
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const listId = useId();
	const activeOptionRef = useRef<HTMLButtonElement>(null);
	const models = answer?.query === query ? answer.models : [];

	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		setLoading(true);
		setError(false);
		const timeout = setTimeout(() => controller.abort(), 12000);
		const debounce = setTimeout(async () => {
			try {
				const base = import.meta.env?.VITE_BACKEND_URL || "";
				const response = await fetch(
					`${base}/providers/ollama/library/search?q=${encodeURIComponent(query)}`,
					{ signal: controller.signal },
				);
				if (!response.ok) throw new Error("search failed");
				const data = await response.json();
				if (!Array.isArray(data.models)) throw new Error("invalid response");
				const verified = data.models.filter(
					(m: Suggestion) =>
						typeof m.value === "string" &&
						/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(
							m.value,
						) &&
						m.source === `https://ollama.com/library/${m.value}`,
				);
				if (active) {
					setAnswer({ query, models: verified });
					setActiveIndex(0);
				}
			} catch {
				if (active) {
					setAnswer(null);
					setError(true);
				}
			} finally {
				clearTimeout(timeout);
				if (active) setLoading(false);
			}
		}, 250);
		return () => {
			active = false;
			clearTimeout(debounce);
			clearTimeout(timeout);
			controller.abort();
		};
	}, [query]);

	useEffect(() => {
		if (answer?.models[activeIndex]) {
			activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
		}
	}, [activeIndex, answer]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				maximizable={false}
				className="relative max-w-[min(32rem,calc(100vw-2rem))] h-[min(30rem,calc(100dvh-2rem))]"
			>
				<DialogHeader>
					<DialogTitle>{t("tasks:logs.model.searchTitle")}</DialogTitle>
					<DialogDescription>
						{t("tasks:logs.model.searchSource")}
					</DialogDescription>
				</DialogHeader>
				<Input
					className="mt-4 w-full"
					maxLength={80}
					role="combobox"
					aria-label={t("tasks:logs.model.customAria")}
					aria-autocomplete="list"
					aria-expanded={models.length > 0}
					aria-controls={listId}
					aria-activedescendant={
						models[activeIndex] ? `${listId}-${activeIndex}` : undefined
					}
					placeholder={t("tasks:logs.model.searchPlaceholder")}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActiveIndex(0);
						setAnswer(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							if (models.length)
								setActiveIndex(
									(i) =>
										(i + (e.key === "ArrowDown" ? 1 : -1) + models.length) %
										models.length,
								);
						} else if (e.key === "Enter") {
							e.preventDefault();
							if (models[activeIndex]) onSelect(models[activeIndex].value);
						}
					}}
				/>
				<p className="mt-2 text-xs text-muted-foreground">
					{t("tasks:logs.model.searchHint")}
				</p>
				{loading && (
					<p role="status" className="mt-3 text-sm">
						{t("tasks:logs.model.searchLoading")}
					</p>
				)}
				{error && (
					<p role="alert" className="mt-3 text-sm text-destructive">
						{t("tasks:logs.model.searchError")}
					</p>
				)}
				{!loading && !error && !models.length && (
					<p role="status" className="mt-3 text-sm">
						{t("tasks:logs.model.searchEmpty")}
					</p>
				)}
				<div
					id={listId}
					role="listbox"
					aria-label={t("tasks:logs.model.searchTitle")}
					className="mt-3 max-h-64 overflow-y-auto min-w-0"
				>
					{models.map((model, index) => (
						<div key={model.value} role="presentation">
							<button
								ref={index === activeIndex ? activeOptionRef : undefined}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === activeIndex}
								type="button"
								tabIndex={-1}
								className={`w-full rounded px-3 py-2 text-left text-sm break-all hover:bg-accent ${index === activeIndex ? "bg-accent" : ""}`}
								onClick={() => onSelect(model.value)}
							>
								{model.value}
							</button>
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
