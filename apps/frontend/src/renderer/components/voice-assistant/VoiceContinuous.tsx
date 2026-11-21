import { Loader2, Mic, MicOff, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceDestination, VoiceIntent } from "@shared/types/voice-assistant";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import { createTask } from "../../stores/task-store";
import { useVoiceAssistantStore } from "../../stores/voice-assistant-store";
import { Button } from "../ui/button";
import { useContinuousCapture } from "./use-continuous-capture";
import { voiceSensitivity } from "./voice-activity";
import { offeredDestinations } from "./voice-destinations";
import { initialLanguage } from "./voice-language";
import { resolveSentence, stopAgentsAfterStep } from "./voice-resolve";
import { readConfirmation } from "./voice-stop";

/** What the mode asked and waits for a « yes » to: a spoken stop, or a task to create. */
type Pending =
	| { kind: "stop" }
	| { kind: "create"; projectId: string; title: string; description: string };

interface Note {
	key: string;
	text?: string;
	count?: number;
}

interface VoiceContinuousProps {
	readonly destinations: readonly VoiceDestination[];
	readonly onNavigate: (view: string) => void;
	readonly onNewTask: () => void;
	readonly onOpenSettings: () => void;
}

/**
 * The voice assistant's continuous mode (issue #385): started from the panel,
 * it keeps the microphone on between sentences and stays on screen, a pulsing
 * dot while it listens, the sentence shown as it is transcribed, and a mute
 * button. Each sentence is read as in the panel (`voice-resolve.ts`); a spoken
 * « stop » or a task to create waits for a « yes » (or the button).
 */
export function VoiceContinuous(props: VoiceContinuousProps) {
	const continuous = useVoiceAssistantStore((s) => s.continuous);
	return continuous ? <ContinuousBar {...props} /> : null;
}

function ContinuousBar({ destinations, onNavigate, onNewTask, onOpenSettings }: VoiceContinuousProps) {
	const { t, i18n } = useTranslation(["voiceAssistant"]);
	const panelOpen = useVoiceAssistantStore((s) => s.isOpen);
	const stopContinuous = useVoiceAssistantStore((s) => s.stopContinuous);
	const projectId = useProjectStore((s) => s.activeProjectId ?? s.selectedProjectId);
	const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
	const sensitivity = voiceSensitivity(useSettingsStore((s) => s.settings.voiceAssistantSensitivity));
	const [language] = useState(() => initialLanguage(i18n.language));
	const [muted, setMuted] = useState(false);
	const [thinking, setThinking] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);
	const [note, setNote] = useState<Note | null>(null);
	const pendingRef = useRef<Pending | null>(null);
	pendingRef.current = pending;
	const offered = useMemo(() => offeredDestinations(destinations), [destinations]);

	const confirm = useCallback(
		async (asked: Pending) => {
			setPending(null);
			if (asked.kind === "stop") {
				setNote(await stopAgentsAfterStep());
				return;
			}
			const task = await createTask(asked.projectId, asked.title.trim(), asked.description.trim());
			setNote(
				task
					? { key: "results.created", text: task.title || asked.title }
					: { key: "results.createFailed" },
			);
		},
		[],
	);

	const act = useCallback(
		(intent: VoiceIntent, said: string) => {
			switch (intent.kind) {
				case "navigate":
					onNavigate(intent.view);
					return;
				case "new-task":
					onNewTask();
					return;
				case "open-settings":
					onOpenSettings();
					return;
				case "create-task":
					if (projectId)
						setPending({ kind: "create", projectId, title: intent.title, description: intent.description });
					else setNote({ key: "results.noProject" });
					return;
				default:
					setNote({ key: "results.unknown", text: said });
			}
		},
		[onNavigate, onNewTask, onOpenSettings, projectId],
	);

	const onSentence = useCallback(
		async (said: string) => {
			const asked = pendingRef.current;
			if (asked) {
				const answer = readConfirmation(said);
				if (answer === "yes") {
					await confirm(asked);
					return;
				}
				if (answer === "no") {
					setPending(null);
					setNote({ key: "continuous.cancelled" });
					return;
				}
				// Anything else is a new command: it replaces the question.
				setPending(null);
			}
			setNote(null);
			const outcome = await resolveSentence(said, offered, language, projectId ?? undefined, () =>
				setThinking(true),
			);
			setThinking(false);
			if (outcome.kind === "stop") setPending({ kind: "stop" });
			else if (outcome.kind === "intent") act(outcome.intent, said.trim());
			else setNote({ key: outcome.key, text: outcome.text });
		},
		[act, confirm, language, offered, projectId],
	);

	const capture = useContinuousCapture({
		active: !muted && !panelOpen,
		language,
		sensitivity,
		projectPath: project?.path,
		onSentence: (said) => void onSentence(said),
	});
	const listening = capture.phase === "listening";
	const status = muted
		? "muted"
		: panelOpen
			? "paused"
			: thinking
				? "thinking"
				: capture.phase === "preparing"
					? "preparing"
					: listening
						? "listening"
						: "off";

	return (
		<section
			aria-label={t("voiceAssistant:continuous.title")}
			className="wp-scope fixed right-4 bottom-4 z-50 w-80 space-y-2 rounded-xl border border-border bg-card p-3 shadow-lg"
		>
			<div className="flex items-center gap-2">
				<span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
					{listening && !muted && (
						<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
					)}
					<span
						className={cn(
							"relative inline-flex h-3 w-3 rounded-full",
							listening && !muted ? "bg-destructive" : "bg-muted-foreground",
							capture.speaking && listening && "scale-125",
						)}
					/>
				</span>
				<p role="status" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
					{(thinking || capture.phase === "preparing") && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
					{t(`voiceAssistant:continuous.phase.${status}`)}
				</p>
				<Button
					type="button"
					size="icon"
					variant={muted ? "default" : "outline"}
					className="h-8 w-8"
					aria-pressed={muted}
					aria-label={t(muted ? "voiceAssistant:continuous.unmute" : "voiceAssistant:continuous.mute")}
					onClick={() => setMuted((value) => !value)}
				>
					{muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
				</Button>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-8 w-8"
					aria-label={t("voiceAssistant:continuous.close")}
					onClick={stopContinuous}
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
				{capture.partial || t("voiceAssistant:continuous.hint")}
			</p>

			{pending && (
				<div className="space-y-2 rounded-lg border border-border p-2" role="alertdialog" aria-label={t("voiceAssistant:continuous.question")}>
					<p className="text-sm">
						{pending.kind === "stop"
							? t("voiceAssistant:stop.confirm")
							: t("voiceAssistant:continuous.createQuestion", { title: pending.title })}
					</p>
					<p className="text-xs text-muted-foreground">{t("voiceAssistant:continuous.sayYes")}</p>
					<div className="flex justify-end gap-2">
						<Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
							{t("voiceAssistant:stop.no")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant={pending.kind === "stop" ? "destructive" : "default"}
							onClick={() => void confirm(pending)}
						>
							{pending.kind === "stop" ? t("voiceAssistant:stop.yes") : t("voiceAssistant:actions.create")}
						</Button>
					</div>
				</div>
			)}

			{note && (
				<p role="status" className="text-xs">
					{t(`voiceAssistant:${note.key}`, { text: note.text, title: note.text, count: note.count })}
				</p>
			)}

			{capture.error && (
				<div role="alert" className="space-y-1 text-xs text-destructive">
					<p>{t(`voiceAssistant:errors.${capture.error}`)}</p>
					<Button type="button" size="sm" variant="outline" onClick={capture.clearError}>
						{t("voiceAssistant:actions.retry")}
					</Button>
				</div>
			)}
		</section>
	);
}
