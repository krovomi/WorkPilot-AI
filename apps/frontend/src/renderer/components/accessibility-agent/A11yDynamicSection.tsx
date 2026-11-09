import { AlertTriangle, MonitorPlay } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { dynamicKey } from "../../../shared/utils/a11y-keys";
import { useAccessibilityStore } from "../../stores/accessibility-store";
import { CharterButton, Notice, ScanLine, Section } from "../charter";
import { Input } from "../ui/input";
import { A11yViolationCard } from "./A11yViolationCard";

/**
 * The running app as a keyboard and a screen reader meet it: the App
 * Emulator's URL, or a localhost one the person types (#391).
 */
export function A11yDynamicSection(): React.ReactElement {
	const { t } = useTranslation("accessibility");
	const running = useAccessibilityStore((s) => s.dynamicRunning);
	const report = useAccessibilityStore((s) => s.dynamicReport);
	const error = useAccessibilityStore((s) => s.dynamicError);
	const start = useAccessibilityStore((s) => s.startDynamicScan);
	const [url, setUrl] = useState("");

	useEffect(() => {
		let alive = true;
		globalThis.electronAPI
			?.getAccessibilityAppUrl?.()
			.then((appUrl) => {
				if (alive && appUrl) setUrl((current) => current || appUrl);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	return (
		<Section
			kicker={t("kickers.dynamic")}
			title={t("dynamic.title")}
			actions={
				<div className="flex flex-wrap items-center gap-2">
					<Input
						type="url"
						aria-label={t("dynamic.url")}
						placeholder="http://localhost:3000"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						className="h-8 w-64 max-w-full text-xs"
					/>
					<CharterButton size="sm" icon={MonitorPlay} busy={running} disabled={running} onClick={() => start(url)}>
						{t("dynamic.run")}
					</CharterButton>
				</div>
			}
		>
			<p className="wp-meta mb-2">{t("dynamic.explain")}</p>
			{running && <ScanLine label={t("dynamic.running")} />}
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("dynamic.failed", { error })}
				</Notice>
			)}
			{report && !running && (
				<div className="grid gap-2.5">
					<p className="wp-meta">
						{t("dynamic.summary", { url: report.url, stops: report.focusStops, count: report.violations.length })}
					</p>
					{report.violations.map((v) => (
						<A11yViolationCard key={dynamicKey(v)} violation={v} />
					))}
				</div>
			)}
		</Section>
	);
}
