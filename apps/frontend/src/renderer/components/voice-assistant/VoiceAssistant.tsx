import { Loader2, Mic, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceDestination, VoiceIntent } from "@shared/types/voice-assistant";
import {
	DEFAULT_VOICE_SHORTCUT,
	formatShortcut,
	matchesShortcut,
} from "@shared/utils/voice-shortcut";
import { toast } from "../../hooks/use-toast";
import { isMacOS } from "../../lib/os-detection";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import { createTask } from "../../stores/task-store";
import { useVoiceAssistantStore } from "../../stores/voice-assistant-store";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";
import { useVoiceCapture } from "./use-voice-capture";
import { VIEW_HINTS } from "./voice-destinations";
import { readVoiceCommand } from "./voice-intent";

const LANGUAGES = ["auto", "fr-FR", "en-US", "en-GB", "es-ES", "de-DE", "it-IT", "pt-BR", "nl-NL"];
const LANGUAGE_KEY = "voice-assistant-language";

type Stage =
	| { kind: "capture" }
	| { kind: "thinking" }
	| { kind: "confirm"; title: string; description: string; saving: boolean }
	| { kind: "message"; key: string; text?: string };

interface VoiceAssistantProps {
	/** The views the sidebar shows right now (server gates and hidden views applied). */
	readonly destinations: readonly VoiceDestination[];
	readonly onNavigate: (view: string) => void;
	readonly onNewTask: () => void;
	readonly onOpenSettings: () => void;
}

function initialLanguage(appLanguage: string): string {
	try {
		const saved = localStorage.getItem(LANGUAGE_KEY);
		if (saved && LANGUAGES.includes(saved)) return saved;
	} catch {
		/* Storage can be disabled. */
	}
	return LANGUAGES.find((lang) => lang.startsWith(appLanguage.split("-")[0])) ?? "auto";
}

/**
 * The voice assistant: a shortcut from anywhere in the app (Ctrl+Shift+Space
 * by default), local dictation, then the sentence read into one of the app's
 * own actions. Design: `docs/architecture/voice-assistant.md`.
 */
export function VoiceAssistant({
	destinations,
	onNavigate,
	onNewTask,
	onOpenSettings,
}: VoiceAssistantProps) {
	const { t, i18n } = useTranslation(["voiceAssistant", "common"]);
	const id = useId();
	const isOpen = useVoiceAssistantStore((s) => s.isOpen);
	const pressCount = useVoiceAssistantStore((s) => s.pressCount);
	const close = useVoiceAssistantStore((s) => s.close);
	const press = useVoiceAssistantStore((s) => s.press);
	const shortcut =
		useSettingsStore((s) => s.settings.voiceAssistantShortcut) || DEFAULT_VOICE_SHORTCUT;
	const mac = useMemo(() => isMacOS(), []);

	// The shortcut works everywhere in the window, inputs and terminals
	// included: it is read in the capture phase, before any field sees it.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!matchesShortcut(event, shortcut, mac)) return;
			if ((event.target as HTMLElement | null)?.closest?.("[data-shortcut-recorder]")) return;
			event.preventDefault();
			event.stopPropagation();
			press();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [shortcut, mac, press]);

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Sparkles className="h-5 w-5 text-primary" />
						{t("voiceAssistant:title")}
					</DialogTitle>
					<DialogDescription>
						{t("voiceAssistant:description")}{" "}
						<span className="whitespace-nowrap">
							{t("voiceAssistant:shortcutHint")}{" "}
							<kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
								{formatShortcut(shortcut, mac)}
							</kbd>
						</span>
					</DialogDescription>
				</DialogHeader>
				{isOpen && (
					<VoiceAssistantBody
						key={id}
						appLanguage={i18n.language}
						pressCount={pressCount}
						destinations={destinations}
						onNavigate={onNavigate}
						onNewTask={onNewTask}
						onOpenSettings={onOpenSettings}
						onClose={close}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Mounted only while the panel is open: closing it releases the microphone. */
function VoiceAssistantBody({
	appLanguage,
	pressCount,
	destinations,
	onNavigate,
	onNewTask,
	onOpenSettings,
	onClose,
}: VoiceAssistantProps & {
	appLanguage: string;
	pressCount: number;
	onClose: () => void;
}) {
	const { t } = useTranslation(["voiceAssistant", "common"]);
	const id = useId();
	const [language, setLanguage] = useState(() => initialLanguage(appLanguage));
	const [text, setText] = useState("");
	const [stage, setStage] = useState<Stage>({ kind: "capture" });
	const textRef = useRef("");
	textRef.current = text;
	const projectId = useProjectStore((s) => s.activeProjectId ?? s.selectedProjectId);
	const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
	const offered = useMemo<VoiceDestination[]>(
		() =>
			destinations
				.filter((d) => d.id !== "voice-control")
				.map((d) => (VIEW_HINTS[d.id] ? { ...d, hint: VIEW_HINTS[d.id].hint } : d)),
		[destinations],
	);

	// An answer that arrives after the panel closed does nothing.
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const act = useCallback(
		(intent: VoiceIntent, said: string) => {
			if (!alive.current) return;
			switch (intent.kind) {
				case "navigate":
					onClose();
					onNavigate(intent.view);
					return;
				case "new-task":
					onClose();
					onNewTask();
					return;
				case "open-settings":
					onClose();
					onOpenSettings();
					return;
				case "create-task":
					if (!projectId) {
						setStage({ kind: "message", key: "results.noProject" });
						return;
					}
					setStage({
						kind: "confirm",
						title: intent.title,
						description: intent.description,
						saving: false,
					});
					return;
				default:
					setStage({ kind: "message", key: "results.unknown", text: said });
			}
		},
		[onClose, onNavigate, onNewTask, onOpenSettings, projectId],
	);

	const interpret = useCallback(
		async (said: string) => {
			const sentence = said.trim();
			if (!sentence) {
				setStage({ kind: "message", key: "results.nothingHeard" });
				return;
			}
			const local = readVoiceCommand(sentence, offered);
			if (local.confident) {
				act(local.intent, sentence);
				return;
			}
			setStage({ kind: "thinking" });
			const answer = await window.electronAPI
				.interpretVoiceCommand(sentence, offered, language, projectId ?? undefined)
				.catch(() => ({ success: false as const, error: "unavailable" as const }));
			if (answer.success) {
				act(answer.intent, sentence);
				return;
			}
			if (local.intent.kind !== "unknown") {
				act(local.intent, sentence);
				return;
			}
			setStage({
				kind: "message",
				key: answer.error === "unavailable" ? "results.noModel" : "results.unknown",
				text: sentence,
			});
		},
		[act, language, offered, projectId],
	);

	const capture = useVoiceCapture({
		language,
		projectPath: project?.path,
		onText: (phrase) => setText((current) => (current ? `${current} ${phrase}` : phrase)),
		onDone: () => void interpret(textRef.current),
	});
	const { phase, start, finish, cancel } = capture;

	// Opening the panel starts listening (`start` does nothing while a session runs).
	useEffect(() => {
		void start();
	}, [start]);

	// The shortcut pressed again: end the sentence, or listen again.
	const handledPress = useRef(pressCount);
	useEffect(() => {
		if (pressCount === handledPress.current) return;
		handledPress.current = pressCount;
		if (phase === "listening") finish();
		else if (phase === "idle" && stage.kind !== "confirm" && stage.kind !== "thinking") {
			setText("");
			setStage({ kind: "capture" });
			void start();
		}
	}, [pressCount, phase, stage.kind, finish, start]);

	const run = () => {
		if (phase === "listening") {
			finish();
			return;
		}
		cancel();
		void interpret(text);
	};

	const listenAgain = () => {
		setText("");
		setStage({ kind: "capture" });
		void start();
	};

	const confirmCreate = async () => {
		if (stage.kind !== "confirm" || !projectId) return;
		setStage({ ...stage, saving: true });
		const task = await createTask(projectId, stage.title.trim(), stage.description.trim());
		if (!task) {
			setStage({ ...stage, saving: false });
			toast({ variant: "destructive", title: t("voiceAssistant:results.createFailed") });
			return;
		}
		toast({
			variant: "success",
			title: t("voiceAssistant:results.created", { title: task.title || stage.title }),
		});
		onClose();
	};

	const names = useMemo(() => new Intl.DisplayNames([appLanguage], { type: "language" }), [appLanguage]);
	const listening = phase === "listening";
	const busy = phase !== "idle" || stage.kind === "thinking";
	const statusKey =
		stage.kind === "thinking" ? "thinking" : phase === "idle" ? "idle" : phase;

	if (stage.kind === "confirm") {
		return (
			<form
				className="mt-4 space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					void confirmCreate();
				}}
			>
				<p className="text-sm font-medium">{t("voiceAssistant:confirm.heading")}</p>
				<div className="space-y-1">
					<label htmlFor={`${id}-title`} className="text-xs text-muted-foreground">
						{t("voiceAssistant:confirm.title")}
					</label>
					<Input
						id={`${id}-title`}
						value={stage.title}
						maxLength={120}
						autoFocus
						onChange={(event) => setStage({ ...stage, title: event.target.value })}
					/>
				</div>
				<div className="space-y-1">
					<label htmlFor={`${id}-description`} className="text-xs text-muted-foreground">
						{t("voiceAssistant:confirm.description")}
					</label>
					<Textarea
						id={`${id}-description`}
						rows={4}
						value={stage.description}
						onChange={(event) => setStage({ ...stage, description: event.target.value })}
					/>
				</div>
				{project?.remote && (
					<p className="text-xs text-muted-foreground">{t("voiceAssistant:confirm.server")}</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={listenAgain}>
						{t("voiceAssistant:actions.retry")}
					</Button>
					<Button
						type="submit"
						disabled={stage.saving || (!stage.title.trim() && !stage.description.trim())}
					>
						{stage.saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{t("voiceAssistant:actions.create")}
					</Button>
				</div>
			</form>
		);
	}

	return (
		<div className="mt-4 space-y-4">
			<div className="flex items-center gap-3">
				<Button
					type="button"
					size="icon"
					variant={listening ? "destructive" : "default"}
					className={cn("h-12 w-12 shrink-0 rounded-full", listening && "animate-pulse")}
					aria-label={t(listening ? "voiceAssistant:actions.stop" : "voiceAssistant:actions.listen")}
					disabled={phase === "preparing" || phase === "downloading" || phase === "finishing"}
					onClick={listening ? finish : listenAgain}
				>
					{listening ? <Square className="h-4 w-4" /> : <Mic className="h-5 w-5" />}
				</Button>
				<div className="min-w-0 flex-1 space-y-1">
					<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
						{(busy && !listening) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
						{t(`voiceAssistant:phase.${statusKey}`)}
					</p>
					<meter
						min={0}
						max={1}
						value={listening ? capture.level : 0}
						aria-label={t("voiceAssistant:level")}
						className="h-1.5 w-full"
					/>
				</div>
				<label htmlFor={`${id}-language`} className="sr-only">
					{t("voiceAssistant:language")}
				</label>
				<NativeSelect
					id={`${id}-language`}
					className="h-auto w-auto px-2 py-1 text-xs"
					value={language}
					disabled={busy}
					onChange={(event) => {
						setLanguage(event.target.value);
						try {
							localStorage.setItem(LANGUAGE_KEY, event.target.value);
						} catch {
							/* Optional preference. */
						}
					}}
				>
					{LANGUAGES.map((lang) => (
						<option key={lang} value={lang}>
							{lang === "auto" ? t("voiceAssistant:auto") : names.of(lang)}
						</option>
					))}
				</NativeSelect>
			</div>

			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					run();
				}}
			>
				<label htmlFor={`${id}-command`} className="sr-only">
					{t("voiceAssistant:input.label")}
				</label>
				<Input
					id={`${id}-command`}
					value={text}
					lang={language === "auto" ? appLanguage : language}
					placeholder={t("voiceAssistant:input.placeholder")}
					onChange={(event) => {
						// Typing takes over from the microphone.
						if (phase === "listening") cancel();
						setText(event.target.value);
					}}
				/>
				<Button type="submit" variant="secondary" disabled={stage.kind === "thinking" || (!text.trim() && !listening)}>
					{t("voiceAssistant:actions.run")}
				</Button>
			</form>

			{capture.error && (
				<div role="alert" className="space-y-2 text-sm text-destructive">
					<p>{t(`voiceAssistant:errors.${capture.error}`)}</p>
					{capture.error === "model" &&
						(project?.path ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => {
									capture.clearError();
									void start(true);
								}}
							>
								{t("voiceAssistant:actions.download")}
							</Button>
						) : (
							<p className="text-xs text-muted-foreground">
								{t("voiceAssistant:errors.downloadNeedsProject")}
							</p>
						))}
				</div>
			)}

			{stage.kind === "message" && (
				<p role="alert" className="text-sm">
					{t(`voiceAssistant:${stage.key}`, { text: stage.text })}
				</p>
			)}

			<div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
				<p className="mb-1 font-medium text-foreground">{t("voiceAssistant:examples.heading")}</p>
				<ul className="space-y-0.5">
					<li>{t("voiceAssistant:examples.createTask")}</li>
					<li>{t("voiceAssistant:examples.open")}</li>
					<li>{t("voiceAssistant:examples.draw")}</li>
					<li>{t("voiceAssistant:examples.settings")}</li>
				</ul>
			</div>
		</div>
	);
}
