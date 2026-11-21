import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AzureDevOpsRemoteConfigModalProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onSave: (config: { orgUrl: string; pat: string }) => void;
	readonly initialConfig?: { orgUrl?: string; pat?: string };
}

export function AzureDevOpsRemoteConfigModal({
	open,
	onOpenChange,
	onSave,
	initialConfig,
}: AzureDevOpsRemoteConfigModalProps) {
	const { t } = useTranslation("dialogs");
	const fieldId = useId();
	const [orgUrl, setOrgUrl] = useState(initialConfig?.orgUrl || "");
	const [pat, setPat] = useState(initialConfig?.pat || "");

	// Validation simple d'URL Azure DevOps
	const isValidUrl = /^https:\/\/dev\.azure\.com\/.+/.test(orgUrl.trim());
	// Said as soon as an address is typed: the button stays disabled until it is fixed.
	const urlError =
		orgUrl.trim() && !isValidUrl ? t("azureConfig.invalidUrl") : null;

	const handleSave = () => {
		onSave({ orgUrl: orgUrl.trim(), pat: pat.trim() });
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-2xl"
				// A click outside or Escape would lose what was typed: only the
				// close button dismisses the form.
				onInteractOutside={(e) => e.preventDefault()}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{t("azureConfig.title")}</DialogTitle>
					<DialogDescription>{t("azureConfig.desc")}</DialogDescription>
				</DialogHeader>
				<div className="py-4 space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${fieldId}-org-url`}>
							{t("azureConfig.orgUrl")}
						</Label>
						<Input
							id={`${fieldId}-org-url`}
							value={orgUrl}
							onChange={(e) => setOrgUrl(e.target.value)}
							placeholder={t("azureConfig.orgUrlPlaceholder")}
							aria-invalid={urlError ? true : undefined}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${fieldId}-pat`}>{t("azureConfig.pat")}</Label>
						<Input
							id={`${fieldId}-pat`}
							value={pat}
							onChange={(e) => setPat(e.target.value)}
							placeholder={t("azureConfig.patPlaceholder")}
							type="password"
						/>
					</div>
					{urlError && (
						<div
							className="text-sm text-destructive bg-destructive/10 rounded-lg p-3"
							role="alert"
						>
							{urlError}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button onClick={handleSave} disabled={!isValidUrl || !pat.trim()}>
						{t("azureConfig.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
