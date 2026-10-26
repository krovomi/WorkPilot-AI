import { BellRing, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, NeedsYouSettings, NeedsYouTestResult } from "../../../shared/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

interface NeedsYouChannelsProps {
	settings: AppSettings;
	onSettingsChange: (settings: AppSettings) => void;
}

/** 24 characters from a 64-letter alphabet: a topic nobody guesses. */
export function randomTopic(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return `workpilot-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/**
 * Where "needs you" goes besides the desktop: an ntfy topic, a Telegram bot.
 *
 * The tokens are app secrets (`global…Token`): stored encrypted and shown
 * masked. The test button sends from the saved settings, in main.
 */
export function NeedsYouChannels({ settings, onSettingsChange }: NeedsYouChannelsProps) {
	const { t } = useTranslation("settings");
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<NeedsYouTestResult | null>(null);

	const needsYou: NeedsYouSettings = settings.needsYou ?? {};
	const ntfy = needsYou.ntfy ?? { enabled: false, topic: "" };
	const telegram = needsYou.telegram ?? { enabled: false, chatId: "", remoteApproval: false };

	const update = (next: NeedsYouSettings) => onSettingsChange({ ...settings, needsYou: next });
	const setNtfy = (patch: Partial<typeof ntfy>) => update({ ...needsYou, ntfy: { ...ntfy, ...patch } });
	const setTelegram = (patch: Partial<typeof telegram>) =>
		update({ ...needsYou, telegram: { ...telegram, ...patch } });

	const test = async () => {
		setTesting(true);
		setResult(null);
		try {
			const response = await globalThis.electronAPI.testNeedsYou();
			setResult(response.success && response.data ? response.data : { ntfy: "failed", telegram: "failed" });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="space-y-4">
			<div className="space-y-3 rounded-lg border border-border p-4">
				<div className="flex items-center justify-between gap-3">
					<div className="space-y-1">
						<Label className="font-medium text-foreground">{t("needsYou.ntfy.title")}</Label>
						<p className="text-sm text-muted-foreground">{t("needsYou.ntfy.description")}</p>
					</div>
					<Switch
						aria-label={t("needsYou.ntfy.title")}
						checked={ntfy.enabled}
						onCheckedChange={(enabled) =>
							setNtfy(enabled && !ntfy.topic ? { enabled, topic: randomTopic() } : { enabled })
						}
					/>
				</div>
				{ntfy.enabled && (
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1">
							<Label htmlFor="needs-you-ntfy-topic" className="text-xs">
								{t("needsYou.ntfy.topic")}
							</Label>
							<div className="flex gap-2">
								<Input
									id="needs-you-ntfy-topic"
									value={ntfy.topic}
									onChange={(e) => setNtfy({ topic: e.target.value.trim() })}
									className="font-mono text-xs"
								/>
								<Button type="button" size="sm" variant="outline" onClick={() => setNtfy({ topic: randomTopic() })}>
									{t("needsYou.ntfy.generate")}
								</Button>
							</div>
							<p className="text-[11px] text-muted-foreground">{t("needsYou.ntfy.topicHint")}</p>
						</div>
						<div className="space-y-1">
							<Label htmlFor="needs-you-ntfy-server" className="text-xs">
								{t("needsYou.ntfy.server")}
							</Label>
							<Input
								id="needs-you-ntfy-server"
								value={ntfy.server ?? ""}
								placeholder="https://ntfy.sh"
								onChange={(e) => setNtfy({ server: e.target.value.trim() || undefined })}
								className="text-xs"
							/>
						</div>
						<div className="space-y-1 sm:col-span-2">
							<Label htmlFor="needs-you-ntfy-token" className="text-xs">
								{t("needsYou.ntfy.token")}
							</Label>
							<Input
								id="needs-you-ntfy-token"
								type="password"
								autoComplete="off"
								value={settings.globalNtfyAccessToken ?? ""}
								onChange={(e) => onSettingsChange({ ...settings, globalNtfyAccessToken: e.target.value })}
								className="text-xs"
							/>
						</div>
					</div>
				)}
			</div>

			<div className="space-y-3 rounded-lg border border-border p-4">
				<div className="flex items-center justify-between gap-3">
					<div className="space-y-1">
						<Label className="font-medium text-foreground">{t("needsYou.telegram.title")}</Label>
						<p className="text-sm text-muted-foreground">{t("needsYou.telegram.description")}</p>
					</div>
					<Switch
						aria-label={t("needsYou.telegram.title")}
						checked={telegram.enabled}
						onCheckedChange={(enabled) => setTelegram({ enabled })}
					/>
				</div>
				{telegram.enabled && (
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1">
							<Label htmlFor="needs-you-telegram-token" className="text-xs">
								{t("needsYou.telegram.botToken")}
							</Label>
							<Input
								id="needs-you-telegram-token"
								type="password"
								autoComplete="off"
								value={settings.globalTelegramBotToken ?? ""}
								onChange={(e) => onSettingsChange({ ...settings, globalTelegramBotToken: e.target.value })}
								className="text-xs"
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="needs-you-telegram-chat" className="text-xs">
								{t("needsYou.telegram.chatId")}
							</Label>
							<Input
								id="needs-you-telegram-chat"
								inputMode="numeric"
								value={telegram.chatId}
								onChange={(e) => setTelegram({ chatId: e.target.value.trim() })}
								className="font-mono text-xs"
							/>
							<p className="text-[11px] text-muted-foreground">{t("needsYou.telegram.chatIdHint")}</p>
						</div>
						<div className="flex items-start justify-between gap-3 sm:col-span-2">
							<div className="space-y-1">
								<Label className="text-sm">{t("needsYou.telegram.remoteApproval")}</Label>
								<p className="text-[11px] text-muted-foreground">
									{t("needsYou.telegram.remoteApprovalHint")}
								</p>
							</div>
							<Switch
								aria-label={t("needsYou.telegram.remoteApproval")}
								checked={telegram.remoteApproval}
								onCheckedChange={(remoteApproval) => setTelegram({ remoteApproval })}
							/>
						</div>
					</div>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
					<Send className="mr-2 h-3.5 w-3.5" aria-hidden />
					{t("needsYou.test")}
				</Button>
				<p className="text-[11px] text-muted-foreground">
					<BellRing className="mr-1 inline h-3 w-3" aria-hidden />
					{t("needsYou.testHint")}
				</p>
			</div>
			{result && (
				<p className="text-xs" role="status">
					{t("needsYou.result", {
						ntfy: t(`needsYou.outcome.${result.ntfy}`),
						telegram: t(`needsYou.outcome.${result.telegram}`),
					})}
				</p>
			)}
		</div>
	);
}
