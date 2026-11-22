import type { PendingDialog } from "@shared/types/browser-recorder";
import { Check, MessageSquareWarning, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useBrowserRecorderStore } from "@/stores/browser-recorder-store";
import { CharterButton, Panel } from "../charter";
import { Input } from "../ui/input";

/**
 * A dialog the recorded page opened (#387): alert, confirm, prompt or "leave
 * the page?". The page waits until the person answers here; the answer is
 * recorded on the action that opened it and replayed by the test. Its message
 * is page content, shown as text.
 */
export function RecorderDialog() {
	const { dialog, answer } = useBrowserRecorderStore(
		useShallow((s) => ({ dialog: s.pendingDialog, answer: s.answerDialog })),
	);
	if (!dialog) return null;
	return <PendingDialogPanel key={dialog.id} dialog={dialog} answer={answer} />;
}

function PendingDialogPanel({
	dialog,
	answer,
}: {
	readonly dialog: PendingDialog;
	readonly answer: (accept: boolean, text: string) => Promise<void>;
}) {
	const { t } = useTranslation(["browserAgent"]);
	const [text, setText] = useState(dialog.defaultValue);
	const prompt = dialog.type === "prompt";
	return (
		<Panel>
			<div role="alertdialog" aria-labelledby="recorder-dialog-title" data-testid="recorder-dialog">
				<h3 id="recorder-dialog-title" className="wp-kicker mb-1 inline-flex items-center gap-1">
					<MessageSquareWarning className="h-3.5 w-3.5" aria-hidden="true" />
					{t(`browserAgent:recorder.dialog.${dialog.type}`)}
				</h3>
				<p className="wp-meta mb-2">{t("browserAgent:recorder.dialog.hint")}</p>
				{dialog.message && <p className="mb-2 whitespace-pre-wrap text-sm">{dialog.message}</p>}
				{prompt && (
					<Input
						type="text"
						value={text}
						onChange={(e) => setText(e.target.value)}
						aria-label={t("browserAgent:recorder.dialog.textLabel")}
						className="mb-2 h-8 text-sm"
					/>
				)}
				<div className="flex flex-wrap gap-2">
					<CharterButton
						size="sm"
						variant="primary"
						icon={Check}
						onClick={() => answer(true, prompt ? text : "")}
					>
						{t("browserAgent:recorder.dialog.accept")}
					</CharterButton>
					{dialog.type !== "alert" && (
						<CharterButton size="sm" icon={X} onClick={() => answer(false, "")}>
							{t("browserAgent:recorder.dialog.dismiss")}
						</CharterButton>
					)}
				</div>
			</div>
		</Panel>
	);
}
