import { Save, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { formatAppDate } from "../../lib/date-format";
import { useDeviceLibraryStore } from "../../stores/device-library-store";
import { useDeviceMatrixStore } from "../../stores/device-matrix-store";
import { Button } from "../ui/button";

const BLANK = "blank";
const PREVIEW = "preview";

/**
 * La session des captures : vierge, celle de l'aperçu, ou un persona
 * enregistré. Enregistrer un persona ne donne qu'un nom au main : il lit
 * lui-même les cookies de l'aperçu et les chiffre ; ce composant n'en voit
 * que le nombre.
 */
export function SessionChoice({ disabled }: { disabled: boolean }) {
	const { t } = useTranslation("appEmulator");
	const { previewSession, persona } = useDeviceMatrixStore(
		useShallow((state) => ({ previewSession: state.previewSession, persona: state.persona })),
	);
	const setPreviewSession = useDeviceMatrixStore((state) => state.setPreviewSession);
	const setPersona = useDeviceMatrixStore((state) => state.setPersona);
	const { personas, saving, problem } = useDeviceLibraryStore(
		useShallow((state) => ({ personas: state.personas, saving: state.saving, problem: state.problem })),
	);
	const savePersona = useDeviceLibraryStore((state) => state.savePersona);
	const deletePersona = useDeviceLibraryStore((state) => state.deletePersona);
	const [name, setName] = useState("");
	const chosen = personas.find((entry) => entry.id === persona);
	const value = chosen ? chosen.id : previewSession ? PREVIEW : BLANK;

	function choose(next: string) {
		if (next === BLANK) {
			setPreviewSession(false);
			setPersona(null);
		} else if (next === PREVIEW) setPreviewSession(true);
		else setPersona(next);
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		const id = await savePersona(name);
		if (id) {
			setName("");
			setPersona(id);
		}
	}

	async function remove(id: string) {
		await deletePersona(id);
		if (!useDeviceLibraryStore.getState().personas.some((entry) => entry.id === id)) setPersona(null);
	}

	return (
		<div className="max-w-md space-y-1 text-sm">
			<label className="flex flex-col gap-1 text-xs font-medium">
				{t("matrix.session.label")}
				<select
					className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
					value={value}
					disabled={disabled}
					onChange={(event) => choose(event.target.value)}
				>
					<option value={BLANK}>{t("matrix.session.blank")}</option>
					<option value={PREVIEW}>{t("matrix.session.preview")}</option>
					{personas.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{t("matrix.session.persona", { name: entry.name })}
						</option>
					))}
				</select>
			</label>
			{value === PREVIEW && <p className="text-xs text-muted-foreground">{t("matrix.previewSessionHint")}</p>}
			{chosen && (
				<div className="flex items-start gap-2">
					<p className="text-xs text-muted-foreground">
						{t("matrix.session.personaHint", {
							count: chosen.cookieCount,
							host: chosen.host,
							date: formatAppDate(chosen.savedAt),
						})}
					</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled || saving}
						aria-label={t("matrix.session.delete")}
						title={t("matrix.session.delete")}
						onClick={() => void remove(chosen.id)}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			)}
			<details>
				<summary className="cursor-pointer text-xs text-muted-foreground">{t("matrix.session.saveTitle")}</summary>
				<form className="mt-1 space-y-1" onSubmit={(event) => void save(event)}>
					<p className="text-xs text-muted-foreground">{t("matrix.session.saveHint")}</p>
					<div className="flex items-end gap-2">
						<label className="flex flex-1 flex-col gap-1 text-xs font-medium">
							{t("matrix.session.personaName")}
							<input
								className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
								value={name}
								maxLength={40}
								disabled={disabled}
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						<Button size="sm" type="submit" disabled={disabled || saving || name.trim() === ""}>
							<Save className="mr-1 h-3.5 w-3.5" />
							{t("matrix.session.save")}
						</Button>
					</div>
				</form>
			</details>
			{problem?.scope === "persona" && (
				<p role="alert" className="text-xs text-destructive">
					{t(`matrix.session.errors.${problem.error}`)}
				</p>
			)}
		</div>
	);
}
