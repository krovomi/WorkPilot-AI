import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface DialogFooterActionsProps {
	readonly provider: {
		readonly isConfigured: boolean;
		readonly id: string;
	} | null;
	readonly activeTab: "api" | "oauth" | "github-copilot";
	readonly isTesting: boolean;
	readonly formData: Record<string, string>;
	readonly onTest: () => void;
	readonly onSave: () => void;
	readonly onDelete: () => void;
	readonly onOpenChange: (open: boolean) => void;
}

export function DialogFooterActions({
	provider,
	activeTab,
	isTesting,
	formData,
	onTest,
	onSave,
	onDelete,
	onOpenChange,
}: DialogFooterActionsProps) {
	const { t } = useTranslation("common");
	// Local servers (Ollama / LM Studio / …) run on a default URL (e.g.
	// localhost:11434) and need NO API key, so the "Test" button must stay
	// enabled even when both fields are empty — otherwise it's permanently greyed.
	const isLocalProvider =
		provider?.id === "ollama" ||
		provider?.id === "lmstudio" ||
		provider?.id === "local";
	const testDisabled =
		isTesting ||
		(activeTab !== "oauth" &&
			!isLocalProvider &&
			!formData.apiKey &&
			!formData.apiUrl);
	return (
		<>
			{provider?.isConfigured && (
				<Button variant="destructive" onClick={onDelete} className="mr-auto">
					{t("actions.delete")}
				</Button>
			)}

			<div className="flex gap-2 ml-auto">
				{/* Windsurf SSO supplies its own save action */}
				{!(provider?.id === "windsurf" && activeTab === "oauth") && (
					<>
						<Button variant="outline" onClick={onTest} disabled={testDisabled}>
							{t(isTesting ? "actions.testing" : "actions.test")}
						</Button>
						<Button onClick={onSave}>{t("actions.save")}</Button>
					</>
				)}
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					{t(activeTab === "api" ? "actions.cancel" : "actions.close")}
				</Button>
			</div>
		</>
	);
}
