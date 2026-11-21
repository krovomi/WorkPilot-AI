import { Mic, MicOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useVoiceAssistantStore } from "../../stores/voice-assistant-store";
import { Button } from "../ui/button";
import { useContinuousCapture } from "./use-continuous-capture";
import { voiceSensitivity } from "./voice-activity";
import { initialLanguage } from "./voice-language";
import { readWakePhrase, wakePhrase } from "./voice-wake";

/**
 * The wake word (issue #385, opt-in in Settings → Voice assistant): while
 * neither the panel nor the continuous mode is open, the microphone waits for
 * « Hey WorkPilot » (or the person's phrase), then opens the panel, on what
 * was said after the phrase when there was something. Every other sentence
 * is dropped. The microphone being on always shows: a pulsing light and a
 * mute button stay at the bottom right.
 */
export function VoiceWake() {
	const enabled = useSettingsStore((s) => s.settings.voiceAssistantWakeWord === true);
	const continuous = useVoiceAssistantStore((s) => s.continuous);
	return enabled && !continuous ? <WakeListener /> : null;
}

function WakeListener() {
	const { t, i18n } = useTranslation(["voiceAssistant"]);
	const phrase = wakePhrase(useSettingsStore((s) => s.settings.voiceAssistantWakePhrase));
	const sensitivity = voiceSensitivity(useSettingsStore((s) => s.settings.voiceAssistantSensitivity));
	const panelOpen = useVoiceAssistantStore((s) => s.isOpen);
	const formDictating = useVoiceAssistantStore((s) => s.formDictations > 0);
	const speaking = useVoiceAssistantStore((s) => s.speaking);
	const openWith = useVoiceAssistantStore((s) => s.openWith);
	const projectId = useProjectStore((s) => s.activeProjectId ?? s.selectedProjectId);
	const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
	const [language] = useState(() => initialLanguage(i18n.language));
	const [muted, setMuted] = useState(false);

	const capture = useContinuousCapture({
		active: !muted && !panelOpen && !formDictating,
		deaf: speaking,
		language,
		sensitivity,
		projectPath: project?.path,
		onSentence: (said) => {
			const heard = readWakePhrase(said, phrase);
			if (heard) openWith(heard.rest);
		},
	});
	if (panelOpen) return null;
	const listening = capture.phase === "listening" && !muted;

	return (
		<section
			aria-label={t("voiceAssistant:wake.title")}
			className="wp-scope fixed right-4 bottom-4 z-50 flex max-w-80 items-center gap-2 rounded-full border border-border bg-card py-1 pr-1 pl-3 shadow-lg"
		>
			<span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
				{listening && (
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
				)}
				<span
					className={cn(
						"relative inline-flex h-2.5 w-2.5 rounded-full",
						listening ? "bg-destructive" : "bg-muted-foreground",
					)}
				/>
			</span>
			<p role="status" className="min-w-0 truncate text-xs">
				{capture.error
					? t(`voiceAssistant:errors.${capture.error}`)
					: muted
						? t("voiceAssistant:wake.muted")
						: formDictating
							? t("voiceAssistant:continuous.phase.dictating")
							: t("voiceAssistant:wake.waiting", { phrase })}
			</p>
			{capture.error ? (
				<Button type="button" size="sm" variant="ghost" className="h-7 shrink-0" onClick={capture.clearError}>
					{t("voiceAssistant:actions.retry")}
				</Button>
			) : (
				<Button
					type="button"
					size="icon"
					variant={muted ? "default" : "ghost"}
					className="h-7 w-7 shrink-0 rounded-full"
					aria-pressed={muted}
					aria-label={t(muted ? "voiceAssistant:continuous.unmute" : "voiceAssistant:continuous.mute")}
					onClick={() => setMuted((value) => !value)}
				>
					{muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
				</Button>
			)}
		</section>
	);
}
