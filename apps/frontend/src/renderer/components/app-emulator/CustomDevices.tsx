import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { DEVICE_PRESETS } from "../../../shared/constants/device-presets";
import type { DevicePreset } from "../../../shared/types/device-matrix";
import { readCustomDeviceDraft } from "../../../shared/utils/custom-device";
import { useDeviceLibraryStore } from "../../stores/device-library-store";
import { Button } from "../ui/button";

interface CustomDevicesProps {
	selected: readonly string[];
	disabled: boolean;
	onToggle: (id: string) => void;
	/** La fenêtre et la densité d'un appareil, comme le reste de la matrice les écrit. */
	dimensions: (device: Pick<DevicePreset, "width" | "height" | "deviceScaleFactor">) => string;
}

const fieldClass = "rounded-md border border-border bg-background px-2 py-1 text-sm font-normal";

/**
 * Les appareils personnalisés : cochés comme ceux du catalogue, et un
 * formulaire pour en décrire un. Le formulaire vérifie les bornes pour le
 * dire tout de suite ; le main les revérifie et donne l'id.
 */
export function CustomDevices({ selected, disabled, onToggle, dimensions }: CustomDevicesProps) {
	const { t } = useTranslation("appEmulator");
	const { customDevices, saving, problem } = useDeviceLibraryStore(
		useShallow((state) => ({ customDevices: state.customDevices, saving: state.saving, problem: state.problem })),
	);
	const addDevice = useDeviceLibraryStore((state) => state.addDevice);
	const removeDevice = useDeviceLibraryStore((state) => state.removeDevice);
	const [name, setName] = useState("");
	const [width, setWidth] = useState("390");
	const [height, setHeight] = useState("844");
	const [scale, setScale] = useState("3");
	const [mobile, setMobile] = useState(true);
	const [touch, setTouch] = useState(true);
	const [userAgent, setUserAgent] = useState(DEVICE_PRESETS[0].userAgent);
	const [invalid, setInvalid] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		const draft = readCustomDeviceDraft({
			name,
			width: Number(width),
			height: Number(height),
			deviceScaleFactor: Number(scale),
			mobile,
			touch,
			userAgent,
		});
		setInvalid(draft === null);
		if (draft && (await addDevice(draft))) setName("");
	}

	return (
		<fieldset className="space-y-1" disabled={disabled}>
			<legend className="text-xs font-medium">{t("matrix.custom.legend")}</legend>
			{customDevices.map((device) => (
				<div key={device.id} className="flex items-center gap-2 text-sm">
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={selected.includes(device.id)} onChange={() => onToggle(device.id)} />
						<span>{device.name}</span>
						<span className="text-xs text-muted-foreground">{dimensions(device)}</span>
					</label>
					<Button
						size="icon"
						variant="ghost"
						className="h-6 w-6"
						aria-label={t("matrix.custom.remove", { name: device.name })}
						title={t("matrix.custom.remove", { name: device.name })}
						onClick={() => void removeDevice(device.id)}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			))}
			<details className="text-sm">
				<summary className="cursor-pointer text-xs text-muted-foreground">{t("matrix.custom.add")}</summary>
				<form className="mt-2 grid max-w-md grid-cols-2 gap-2" onSubmit={(event) => void submit(event)}>
					<p className="col-span-2 text-xs text-muted-foreground">{t("matrix.custom.hint")}</p>
					<label className="col-span-2 flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.name")}
						<input className={fieldClass} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.width")}
						<input className={fieldClass} type="number" min={240} max={3840} value={width} onChange={(e) => setWidth(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.height")}
						<input className={fieldClass} type="number" min={240} max={3840} value={height} onChange={(e) => setHeight(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.scale")}
						<input className={fieldClass} type="number" min={1} max={4} step={0.025} value={scale} onChange={(e) => setScale(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.userAgentFrom")}
						<select
							className={fieldClass}
							value={DEVICE_PRESETS.find((device) => device.userAgent === userAgent)?.id ?? ""}
							onChange={(e) => {
								const preset = DEVICE_PRESETS.find((device) => device.id === e.target.value);
								if (preset) setUserAgent(preset.userAgent);
							}}
						>
							{DEVICE_PRESETS.map((device) => (
								<option key={device.id} value={device.id}>
									{t(`devices.${device.id}`)}
								</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-2 text-xs">
						<input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
						{t("matrix.custom.mobile")}
					</label>
					<label className="flex items-center gap-2 text-xs">
						<input type="checkbox" checked={touch} onChange={(e) => setTouch(e.target.checked)} />
						{t("matrix.custom.touch")}
					</label>
					<label className="col-span-2 flex flex-col gap-1 text-xs font-medium">
						{t("matrix.custom.userAgent")}
						<input className={fieldClass} value={userAgent} maxLength={512} onChange={(e) => setUserAgent(e.target.value)} />
					</label>
					{invalid && (
						<p role="alert" className="col-span-2 text-xs text-destructive">
							{t("matrix.custom.invalid")}
						</p>
					)}
					{problem?.scope === "device" && (
						<p role="alert" className="col-span-2 text-xs text-destructive">
							{t(`matrix.custom.errors.${problem.error}`)}
						</p>
					)}
					<div className="col-span-2">
						<Button size="sm" type="submit" disabled={saving}>
							<Plus className="mr-1 h-3.5 w-3.5" />
							{t("matrix.custom.save")}
						</Button>
					</div>
				</form>
			</details>
		</fieldset>
	);
}
