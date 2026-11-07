import { Keyboard, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@shared/types";
import {
	acceleratorFromEvent,
	DEFAULT_VOICE_SHORTCUT,
	formatShortcut,
	shortcutConflict,
} from "@shared/utils/voice-shortcut";
import { isMacOS } from "../../lib/os-detection";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./SettingsSection";

interface VoiceAssistantSettingsProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** The assistant's shortcut and whether it also works in the background. */
export function VoiceAssistantSettings({ settings, onSettingsChange }: VoiceAssistantSettingsProps) {
	const { t } = useTranslation("voiceAssistant");
	const mac = useMemo(() => isMacOS(), []);
	const shortcut = settings.voiceAssistantShortcut || DEFAULT_VOICE_SHORTCUT;
	const [recording, setRecording] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [osState, setOsState] = useState<"off" | "registered" | "refused">("off");

	useEffect(() => {
		let current = true;
		void window.electronAPI
			.getVoiceShortcutStatus?.()
			.then((state) => {
				if (current) setOsState(state);
			})
			.catch(() => {
				/* Shown as off. */
			});
		return () => {
			current = false;
		};
	}, []);

	const onRecordKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (!recording) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			setRecording(false);
			return;
		}
		if (MODIFIER_KEYS.has(event.key)) return;
		const accelerator = acceleratorFromEvent(event, mac);
		const conflict = accelerator ? shortcutConflict(accelerator) : "invalid";
		if (!accelerator || conflict) {
			setRefusal(conflict ?? "invalid");
			return;
		}
		setRefusal(null);
		setRecording(false);
		onSettingsChange({ ...settings, voiceAssistantShortcut: accelerator });
	};

	const refusalText =
		refusal === null
			? null
			: refusal === "invalid" || refusal === "altgr"
				? t(`settings.conflict.${refusal}`)
				: t("settings.conflict.used", { shortcut: refusal });

	return (
		<SettingsSection title={t("settings.title")} description={t("settings.description")}>
			<div className="space-y-6">
				<div className="space-y-2">
					<Label htmlFor="voice-assistant-shortcut">{t("settings.shortcut")}</Label>
					<div className="flex flex-wrap items-center gap-2">
						<kbd className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm">
							{formatShortcut(shortcut, mac)}
						</kbd>
						<Button
							id="voice-assistant-shortcut"
							type="button"
							variant={recording ? "default" : "outline"}
							size="sm"
							data-shortcut-recorder=""
							onClick={() => {
								setRefusal(null);
								setRecording((value) => !value);
							}}
							onKeyDown={onRecordKey}
							onBlur={() => setRecording(false)}
						>
							<Keyboard className="mr-2 h-4 w-4" />
							{recording ? t("settings.recording") : t("settings.change")}
						</Button>
						{shortcut !== DEFAULT_VOICE_SHORTCUT && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setRefusal(null);
									onSettingsChange({ ...settings, voiceAssistantShortcut: DEFAULT_VOICE_SHORTCUT });
								}}
							>
								<RotateCcw className="mr-2 h-4 w-4" />
								{t("settings.reset")}
							</Button>
						)}
					</div>
					<p className="text-xs text-muted-foreground">{t("settings.shortcutHelp")}</p>
					{refusalText && (
						<p role="alert" className="text-xs text-destructive">
							{refusalText}
						</p>
					)}
				</div>

				<div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
					<div className="space-y-1">
						<Label htmlFor="voice-assistant-system-wide">{t("settings.systemWide")}</Label>
						<p className="text-xs text-muted-foreground">{t("settings.systemWideHelp")}</p>
						{settings.voiceAssistantSystemWide && osState === "refused" && (
							<p role="alert" className="text-xs text-warning">
								{t("settings.systemWideRefused")}
							</p>
						)}
					</div>
					<Switch
						id="voice-assistant-system-wide"
						checked={settings.voiceAssistantSystemWide === true}
						onCheckedChange={(checked) =>
							onSettingsChange({ ...settings, voiceAssistantSystemWide: checked })
						}
					/>
				</div>

				<div className="space-y-1 text-xs text-muted-foreground">
					<p>{t("settings.speech")}</p>
					<p>{t("settings.model")}</p>
				</div>
			</div>
		</SettingsSection>
	);
}
