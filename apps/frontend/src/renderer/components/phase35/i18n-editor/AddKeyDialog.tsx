/**
 * Creating a key, and saying no before the round trip.
 *
 * The key is validated here against the same rule the backend enforces
 * (`drafts.keyError` mirrors `editor.validate_key`) and against the keys
 * already in the namespace, so the two mistakes that are certain to happen —
 * a stray dot, a name already taken — are answered under the cursor rather
 * than by a failed save.
 *
 * A locale left blank is left *absent*, not written as an empty string. That
 * is the same distinction `EntryCell` draws, and it is what keeps the coverage
 * report honest about a key that still needs translating.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { keyError } from "./drafts";

interface AddKeyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	locales: string[];
	/** Every key already in the namespace, draft included. */
	existingKeys: string[];
	namespace: string;
	onAdd: (key: string, values: Record<string, string>) => void;
}

export function AddKeyDialog({
	open,
	onOpenChange,
	locales,
	existingKeys,
	namespace,
	onAdd,
}: AddKeyDialogProps) {
	const { t } = useTranslation("phase35");
	const [key, setKey] = useState("");
	const [values, setValues] = useState<Record<string, string>>({});

	const error = useMemo(() => {
		const trimmed = key.trim();
		if (!trimmed) return null; // nothing typed yet is not yet a mistake
		const shape = keyError(trimmed);
		if (shape) return t(`i18nEditor.keyError.${shape}`);
		if (existingKeys.includes(trimmed)) return t("i18nEditor.keyError.taken");
		// `a.b` and `a.b.c` cannot both hold a value — one would have to be an
		// object. The backend refuses it; saying so here names the key in the way.
		const clash = existingKeys.find(
			(k) => k.startsWith(`${trimmed}.`) || trimmed.startsWith(`${k}.`),
		);
		if (clash) return t("i18nEditor.keyError.nests", { key: clash });
		return null;
	}, [key, existingKeys, t]);

	const canSubmit = key.trim().length > 0 && !error;

	const close = () => {
		setKey("");
		setValues({});
		onOpenChange(false);
	};

	const submit = () => {
		if (!canSubmit) return;
		const filled = Object.fromEntries(
			Object.entries(values).filter(([, v]) => v.trim().length > 0),
		);
		onAdd(key.trim(), filled);
		close();
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("i18nEditor.addKeyTitle")}</DialogTitle>
					<DialogDescription>
						{t("i18nEditor.addKeyDescription", {
							namespace: namespace || t("i18nEditor.flatNamespace"),
						})}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<label htmlFor="new-key-input" className="mb-1 block text-xs font-medium">
							{t("i18nEditor.keyLabel")}
						</label>
						<input
							id="new-key-input"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && canSubmit) submit();
							}}
							placeholder={t("i18nEditor.keyPlaceholder")}
							aria-invalid={Boolean(error) || undefined}
							aria-describedby={error ? "new-key-error" : undefined}
							className="w-full rounded border bg-background p-2 font-mono text-xs"
							autoFocus
						/>
						{error && (
							<p id="new-key-error" className="mt-1 text-xs text-destructive">
								{error}
							</p>
						)}
					</div>

					{locales.map((locale) => (
						<div key={locale}>
							<label
								htmlFor={`new-key-${locale}`}
								className="mb-1 block text-xs font-medium"
							>
								<span className="font-mono">{locale}</span>{" "}
								<span className="font-normal text-muted-foreground">
									{t("i18nEditor.optional")}
								</span>
							</label>
							<textarea
								id={`new-key-${locale}`}
								rows={2}
								value={values[locale] ?? ""}
								onChange={(e) =>
									setValues((v) => ({ ...v, [locale]: e.target.value }))
								}
								className="w-full resize-none rounded border bg-background p-2 text-xs"
							/>
						</div>
					))}
					<p className="text-xs text-muted-foreground">
						{t("i18nEditor.addKeyBlankHint")}
					</p>
				</div>

				<DialogFooter>
					<Button variant="ghost" size="sm" onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button size="sm" onClick={submit} disabled={!canSubmit}>
						{t("i18nEditor.addKeyConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
