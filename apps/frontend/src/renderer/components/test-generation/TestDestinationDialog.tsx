import { FolderPlus, FolderSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DestinationCandidateKind,
	TestDestination,
} from "../../../shared/types/test-generation";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";

interface TestDestinationDialogProps {
	/** The unresolved destination. `null` closes the dialog. */
	readonly destination: TestDestination | null;
	readonly onConfirm: (directory: string) => void;
	readonly onCancel: () => void;
	/** One extra line of context, e.g. that a batch reuses this answer. */
	readonly note?: string;
}

const CUSTOM = "__custom__";

const KIND_LABELS: Record<DestinationCandidateKind, string> = {
	existing_tests_dir: "testGeneration:destination.kind.existingTestsDir",
	sibling_of_source_root: "testGeneration:destination.kind.besideSourceRoot",
	project_tests: "testGeneration:destination.kind.projectRoot",
	source_dir: "testGeneration:destination.kind.besideSource",
};

/**
 * Ask where the generated tests should be written.
 *
 * Shown only when the backend could not justify a directory on its own — no
 * `tests` beside the source root, nothing existing to extend. Before this
 * dialog the file went to the project root, which on a .NET solution meant the
 * unit tests landed next to the `.sln`.
 *
 * The candidates come from the project, not from this component: it renders
 * them and lets the user type a path of their own, which is created on write.
 */
export function TestDestinationDialog({
	destination,
	onConfirm,
	onCancel,
	note,
}: TestDestinationDialogProps) {
	const { t } = useTranslation(["testGeneration", "common"]);
	const candidates = useMemo(
		() => destination?.candidates ?? [],
		[destination?.candidates],
	);
	const [selected, setSelected] = useState<string>("");
	const [customPath, setCustomPath] = useState("");

	// Re-seed on every new question: the recommendation is the first candidate,
	// which is the directory the project's own layout points at.
	useEffect(() => {
		setSelected(candidates[0]?.path ?? CUSTOM);
		setCustomPath("");
	}, [candidates]);

	if (!destination) return null;

	const chosen = selected === CUSTOM ? customPath.trim() : selected;

	const handleBrowse = async () => {
		try {
			const picked = await globalThis.electronAPI.selectDirectory();
			if (picked) {
				setCustomPath(picked);
				setSelected(CUSTOM);
			}
		} catch {
			// The picker is a convenience; the text field still accepts a path.
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderPlus className="h-5 w-5" />
						{t("testGeneration:destination.title")}
					</DialogTitle>
					<DialogDescription>
						{destination.reason === "no_source_root"
							? t("testGeneration:destination.noSourceRoot")
							: t("testGeneration:destination.noTestsDir", {
									sourceRoot: destination.sourceRoot ?? "",
								})}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
						{destination.fileName}
					</div>

					<RadioGroup value={selected} onValueChange={setSelected}>
						{candidates.map((candidate) => (
							<div key={candidate.path} className="flex items-start gap-2">
								<RadioGroupItem
									value={candidate.path}
									id={`destination-${candidate.path}`}
									className="mt-1"
								/>
								<Label
									htmlFor={`destination-${candidate.path}`}
									className="flex-1 cursor-pointer font-normal"
								>
									<span className="block break-all font-mono text-xs">
										{candidate.path}
									</span>
									<span className="block text-xs text-muted-foreground">
										{t(KIND_LABELS[candidate.kind])}
										{candidate.exists
											? ""
											: ` · ${t("testGeneration:destination.willBeCreated")}`}
									</span>
								</Label>
							</div>
						))}

						<div className="flex items-start gap-2">
							<RadioGroupItem
								value={CUSTOM}
								id="destination-custom"
								className="mt-1"
							/>
							<div className="flex-1 space-y-2">
								<Label
									htmlFor="destination-custom"
									className="cursor-pointer font-normal"
								>
									{t("testGeneration:destination.custom")}
								</Label>
								<div className="flex gap-2">
									<Input
										value={customPath}
										onChange={(event) => {
											setCustomPath(event.target.value);
											setSelected(CUSTOM);
										}}
										placeholder={t("testGeneration:destination.customPlaceholder")}
										className="font-mono text-xs"
									/>
									<Button
										type="button"
										variant="outline"
										size="icon"
										onClick={handleBrowse}
										aria-label={t("testGeneration:destination.browse")}
									>
										<FolderSearch className="h-4 w-4" />
									</Button>
								</div>
							</div>
						</div>
					</RadioGroup>

					{note && <p className="text-xs text-muted-foreground">{note}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						{t("common:buttons.cancel", { defaultValue: "Cancel" })}
					</Button>
					<Button disabled={!chosen} onClick={() => onConfirm(chosen)}>
						{t("testGeneration:destination.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
