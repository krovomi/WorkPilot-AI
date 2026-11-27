import { Box, Info, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentSafetySettings } from "../../../shared/types";
import type { MicrovmStatus } from "../../../shared/types/task-sandbox";
import { RangeRow, SwitchRow } from "./agent-safety-controls";

const K = "sections.sandbox.microvm";

type Microvm = AgentSafetySettings["sandbox"]["microvm"];

/**
 * Settings, Sandbox: one Docker Sandboxes microVM per task
 * (`apps/backend/os_sandbox/microvm.py`). Off by default; off, the OS sandbox
 * works as before. The size sliders read 0 as "sized from the machine".
 */
export function MicrovmSettings({
	microvm,
	onChange,
}: {
	readonly microvm: Microvm;
	readonly onChange: (patch: Partial<Microvm>) => void;
}) {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<MicrovmStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const check = useCallback(async () => {
		const read = window.electronAPI?.getMicrovmStatus;
		if (typeof read !== "function") return;
		setChecking(true);
		try {
			setStatus(await read());
		} catch {
			setStatus(null);
		} finally {
			setChecking(false);
		}
	}, []);
	useEffect(() => {
		if (microvm.enabled) void check();
	}, [microvm.enabled, check]);
	const auto = (value: number, unit: string) => (value === 0 ? t(`${K}.auto`) : `${value}${unit}`);
	return (
		<div className="space-y-3">
			<h4 className="text-sm font-semibold flex items-center gap-2">
				<Box className="h-4 w-4 text-primary" />
				{t(`${K}.title`)}
			</h4>
			<p className="text-xs text-muted-foreground">{t(`${K}.description`)}</p>
			<SwitchRow
				id="sandbox-microvm"
				icon={<Box className="h-5 w-5 text-primary" />}
				title={t(`${K}.enable`)}
				description={t(`${K}.enableHint`)}
				checked={microvm.enabled}
				onChange={(enabled) => onChange({ enabled })}
			/>
			{microvm.enabled && (
				<>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<RangeRow
							id="sandbox-microvm-memory"
							label={t(`${K}.memory`)}
							hint={t(`${K}.memoryHint`)}
							value={microvm.memoryGb}
							display={auto(microvm.memoryGb, " GiB")}
							min={0}
							max={64}
							step={1}
							onChange={(memoryGb) => onChange({ memoryGb })}
						/>
						<RangeRow
							id="sandbox-microvm-cpus"
							label={t(`${K}.cpus`)}
							hint={t(`${K}.cpusHint`)}
							value={microvm.cpus}
							display={auto(microvm.cpus, "")}
							min={0}
							max={16}
							step={1}
							onChange={(cpus) => onChange({ cpus })}
						/>
					</div>
					<div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-xs">
						<span
							className={status?.ready ? "text-success" : "text-warning"}
							data-testid="microvm-status"
						>
							{status === null
								? t(`${K}.status.unknown`)
								: status.ready
									? t(`${K}.status.ready`, { version: status.version ?? "", count: status.vms })
									: status.installed
										? t(`${K}.status.notReady`, { reason: status.reason ?? "" })
										: t(`${K}.status.missing`)}
						</span>
						<button
							type="button"
							onClick={() => void check()}
							disabled={checking}
							className="flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent/50 disabled:opacity-50"
						>
							<RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
							{t(`${K}.status.check`)}
						</button>
					</div>
					<div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
						<div className="flex items-start gap-2">
							<Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
							<span>{t(`${K}.requirements`)}</span>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
