import { Box, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentSafetySettings } from "../../../shared/types";
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
