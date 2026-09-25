import { Mic, Square, Undo2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { appendDictation, appendTranscript, undoDictation } from "./dictation";
import { captureDictation } from "./dictation-audio";

const languages = [
	"auto",
	"fr-FR",
	"fr-CA",
	"en-US",
	"en-GB",
	"en-AU",
	"en-IN",
	"es-ES",
	"es-MX",
	"es-AR",
	"de-DE",
	"de-AT",
	"de-CH",
	"it-IT",
	"pt-PT",
	"pt-BR",
	"nl-NL",
	"pl-PL",
	"ja-JP",
	"zh-CN",
	"ar",
	"uk-UA",
];
type Phase = "idle" | "preparing" | "recording" | "finishing" | "downloading";

export function TaskDictation({
	description,
	onChange,
	richText,
	disabled,
	projectPath,
	onPendingChange,
}: {
	description: string;
	onChange: (value: string) => void;
	richText: boolean;
	disabled?: boolean;
	projectPath?: string;
	onPendingChange?: (pending: boolean) => void;
}) {
	const { t, i18n } = useTranslation("tasks");
	const id = useId();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState("");
	const [level, setLevel] = useState(0);
	const [seconds, setSeconds] = useState(0);
	const [language, setLanguage] = useState(() => {
		try {
			const saved = localStorage.getItem("task-dictation-language");
			if (saved && languages.includes(saved)) return saved;
		} catch {
			/* Storage can be disabled. */
		}
		return (
			languages.find((lang) => lang.startsWith(i18n.language.split("-")[0])) ??
			"auto"
		);
	});
	const [insertion, setInsertion] = useState<{
		before: string;
		after: string;
	} | null>(null);
	const draftRef = useRef<HTMLTextAreaElement>(null);
	const selection = useRef<[number, number] | null>(null);
	const composing = useRef(false);
	const deferredText = useRef("");
	const receiveText = (text: string) => {
		if (composing.current) {
			deferredText.current = appendTranscript(deferredText.current, text);
			return;
		}
		const field = draftRef.current;
		if (field && document.activeElement === field)
			selection.current = [field.selectionStart, field.selectionEnd];
		setDraft((latest) => appendTranscript(latest, text));
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: Restore selection after an incoming phrase updates the controlled value.
	useLayoutEffect(() => {
		const field = draftRef.current;
		if (selection.current && field && document.activeElement === field)
			field.setSelectionRange(...selection.current);
		selection.current = null;
	}, [draft]);
	useEffect(() => {
		onPendingChange?.(phase !== "idle" || Boolean(draft.trim()));
	}, [phase, draft, onPendingChange]);
	useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
	const session = useRef<string | null>(null);
	const stopAudio = useRef<((discard?: boolean) => void) | null>(null);
	const queue = useRef<Promise<void>>(Promise.resolve());
	const queued = useRef(0);
	const phaseRef = useRef<Phase>("idle");
	const transition = useCallback((next: Phase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);
	const cancel = useCallback(() => {
		const current = session.current;
		session.current = null;
		stopAudio.current?.(true);
		stopAudio.current = null;
		if (current)
			void window.electronAPI.dictationCancel(current).catch(() => {
				/* The renderer may be closing. */
			});
		transition("idle");
		setLevel(0);
	}, [transition]);
	const finish = () => {
		if (phaseRef.current !== "recording") return;
		transition("finishing");
		stopAudio.current?.();
		stopAudio.current = null;
		setLevel(0);
		const current = session.current;
		void queue.current.finally(() => {
			if (current && session.current === current) cancel();
		});
	};
	useEffect(
		() => () => {
			const current = session.current;
			session.current = null;
			stopAudio.current?.(true);
			if (current)
				void window.electronAPI.dictationCancel(current).catch(() => {
					/* The renderer may be closing. */
				});
		},
		[],
	);
	useEffect(() => {
		if (disabled) cancel();
	}, [disabled, cancel]);
	useEffect(() => {
		if (phase !== "recording") return;
		const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
		return () => clearInterval(timer);
	}, [phase]);
	const start = async (download = false) => {
		if (phaseRef.current !== "idle" || disabled) return;
		const current = crypto.randomUUID();
		session.current = current;
		setError("");
		setOpen(true);
		setSeconds(0);
		transition(download ? "downloading" : "preparing");
		queue.current = Promise.resolve();
		queued.current = 0;
		try {
			const result = await window.electronAPI.dictationStart(
				current,
				download,
				projectPath,
			);
			if (session.current !== current) return;
			if (result.error || !result.ready)
				throw new Error(result.error || "transcription");
			if (download) {
				cancel();
				return;
			}
			const stop = await captureDictation(
				(audio) => {
					if (session.current !== current) return;
					// Bound the audio backlog; preserve already queued speech if CPU falls behind.
					queued.current++;
					queue.current = queue.current.then(async () => {
						if (session.current !== current) return;
						try {
							const response = await window.electronAPI.dictationTranscribe(
								current,
								audio,
								language,
							);
							if (session.current !== current) return;
							if (response.error) throw new Error(response.error);
							if (response.text) receiveText(response.text);
						} catch {
							if (session.current === current) {
								setError("transcription");
								cancel();
							}
						} finally {
							if (session.current === current) queued.current--;
						}
					});
					if (queued.current >= 4) {
						setError("backlog");
						queueMicrotask(finish);
					}
				},
				setLevel,
				finish,
			);
			if (session.current !== current) {
				stop(true);
				return;
			}
			stopAudio.current = stop;
			transition("recording");
		} catch (caught) {
			if (session.current !== current) return;
			const code = caught instanceof Error ? caught.message : "microphone";
			setError(
				[
					"model",
					"dependency",
					"offline",
					"download",
					"busy",
					"timeout",
					"transcription",
				].includes(code)
					? code
					: "microphone",
			);
			cancel();
		}
	};
	const busy = phase !== "idle";
	const names = new Intl.DisplayNames([i18n.language], { type: "language" });
	return (
		<div className="space-y-2 rounded-lg border border-border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled || busy}
					onClick={() => void start()}
				>
					<Mic className="mr-2 h-4 w-4" />
					{t(`dictation.${draft ? "resume" : "start"}`)}
				</Button>
				{phase === "recording" && (
					<Button
						type="button"
						variant="destructive"
						size="sm"
						onClick={finish}
					>
						<Square className="mr-2 h-3 w-3" />
						{t("dictation.stop")}
					</Button>
				)}
				<label htmlFor={`${id}-language`} className="sr-only">
					{t("dictation.language")}
				</label>
				<select
					id={`${id}-language`}
					className="rounded-md border border-input bg-background px-2 py-1 text-sm"
					value={language}
					disabled={disabled || busy}
					onChange={(event) => {
						setLanguage(event.target.value);
						try {
							localStorage.setItem(
								"task-dictation-language",
								event.target.value,
							);
						} catch {
							/* Optional preference. */
						}
					}}
				>
					{languages.map((lang) => (
						<option key={lang} value={lang}>
							{lang === "auto" ? t("dictation.auto") : names.of(lang)}
						</option>
					))}
				</select>
				{busy && (
					<span role="status" className="text-xs text-muted-foreground">
						{t(`dictation.${phase}`)}
						{phase === "recording" &&
							` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
					</span>
				)}
				{phase === "recording" && (
					<meter
						min={0}
						max={1}
						value={level}
						aria-label={t("dictation.level")}
						className="h-2 w-16"
					/>
				)}
			</div>
			<p className="text-xs text-muted-foreground">{t("dictation.help")}</p>
			{error && (
				<div role="alert" className="space-y-2 text-sm text-destructive">
					<p>{t(`dictation.errors.${error}`)}</p>
					{error === "model" && (
						<Button
							type="button"
							variant="outline"
							disabled={disabled || busy || !projectPath}
							onClick={() => void start(true)}
						>
							{t("dictation.download")}
						</Button>
					)}
				</div>
			)}
			{open && (
				<div className="space-y-2">
					<label htmlFor={`${id}-draft`} className="text-sm font-medium">
						{t("dictation.draft")}
					</label>
					<Textarea
						ref={draftRef}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
							const text = deferredText.current;
							deferredText.current = "";
							if (text) receiveText(text);
						}}
						id={`${id}-draft`}
						value={draft}
						spellCheck
						lang={language === "auto" ? i18n.language : language}
						disabled={disabled}
						rows={4}
						onChange={(event) => setDraft(event.target.value)}
						placeholder={t("dictation.placeholder")}
					/>
					<p className="text-xs text-muted-foreground">
						{t("dictation.editHelp")} {t("dictation.pending")}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							disabled={disabled || busy || !draft.trim()}
							onClick={() => {
								const edit = appendDictation(description, draft, richText);
								onChange(edit.after);
								setInsertion(edit);
								setDraft("");
								setOpen(false);
							}}
						>
							{t("dictation.insert")}
						</Button>
						<Button
							type="button"
							variant="ghost"
							disabled={disabled}
							onClick={() => {
								cancel();
								deferredText.current = "";
								composing.current = false;
								setDraft("");
								setError("");
								setOpen(false);
							}}
						>
							{t("dictation.cancel")}
						</Button>
					</div>
				</div>
			)}
			{insertion && description === insertion.after && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled || busy}
					onClick={() => {
						const previous = undoDictation(description, insertion);
						if (previous !== null) onChange(previous);
						setInsertion(null);
					}}
				>
					<Undo2 className="mr-2 h-3 w-3" />
					{t("dictation.undo")}
				</Button>
			)}
		</div>
	);
}
