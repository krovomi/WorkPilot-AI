import { Check, Loader2, PackagePlus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
	LibraryCategory,
	PackageInstallReport,
	TestLibrary,
	TestLibrarySelection,
} from "../../../shared/types/test-generation";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";

interface TestLibrariesPickerProps {
	readonly selection: TestLibrarySelection | null;
	readonly chosen: string[];
	readonly missing: TestLibrary[];
	readonly loading: boolean;
	readonly installing: boolean;
	readonly report: PackageInstallReport | null;
	readonly error: string | null;
	readonly onToggle: (id: string) => void;
	readonly onReset: () => void;
	readonly onAddPackages: () => void;
	/** Hides the install button where there is no project to install into. */
	readonly canInstall?: boolean;
}

const CATEGORY_LABELS: Record<LibraryCategory, string> = {
	framework: "testGeneration:libraries.category.framework",
	assertions: "testGeneration:libraries.category.assertions",
	mocking: "testGeneration:libraries.category.mocking",
	data: "testGeneration:libraries.category.data",
	http: "testGeneration:libraries.category.http",
	ui: "testGeneration:libraries.category.ui",
	snapshot: "testGeneration:libraries.category.snapshot",
	coverage: "testGeneration:libraries.category.coverage",
};

/** Group in the order the backend sent, so frameworks stay first. */
function groupByCategory(libraries: TestLibrary[]): [LibraryCategory, TestLibrary[]][] {
	const groups = new Map<LibraryCategory, TestLibrary[]>();
	for (const library of libraries) {
		const bucket = groups.get(library.category);
		if (bucket) bucket.push(library);
		else groups.set(library.category, [library]);
	}
	return [...groups.entries()];
}

/**
 * Pick the libraries the generated tests are written against.
 *
 * Opens on the project's own answer — the packages its manifests already
 * reference are ticked, and marked as installed — so the common case needs no
 * interaction at all. What it adds is the case the project cannot answer: a
 * solution with no test project yet, where "FluentAssertions and Moq" is a
 * decision only the user can make, and the packages have to be added before
 * the generated file compiles.
 */
export function TestLibrariesPicker({
	selection,
	chosen,
	missing,
	loading,
	installing,
	report,
	error,
	onToggle,
	onReset,
	onAddPackages,
	canInstall = true,
}: TestLibrariesPickerProps) {
	const { t } = useTranslation(["testGeneration", "common"]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="h-3 w-3 animate-spin" />
				{t("testGeneration:libraries.loading")}
			</div>
		);
	}

	if (!selection || selection.libraries.length === 0) return null;

	const groups = groupByCategory(selection.libraries);

	return (
		<div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h4 className="text-sm font-medium">
						{t("testGeneration:libraries.title")}
					</h4>
					<p className="text-xs text-muted-foreground">
						{t("testGeneration:libraries.description")}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onReset}
					disabled={installing}
					title={t("testGeneration:libraries.reset")}
				>
					<RotateCcw className="mr-1.5 h-3.5 w-3.5" />
					{t("testGeneration:libraries.reset")}
				</Button>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				{groups.map(([category, libraries]) => (
					<div key={category} className="space-y-1.5">
						<span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							{t(CATEGORY_LABELS[category] ?? category)}
						</span>
						{libraries.map((library) => {
							const picked = chosen.includes(library.id);
							const inputId = `test-library-${library.id}`;
							return (
								<div
									key={library.id}
									className={cn(
										"flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-secondary/40",
										picked && "bg-secondary/30",
									)}
									title={library.usage}
								>
									<Checkbox
										id={inputId}
										checked={picked}
										disabled={installing}
										onCheckedChange={() => onToggle(library.id)}
										className="mt-0.5"
									/>
									<Label
										htmlFor={inputId}
										className="min-w-0 flex-1 cursor-pointer font-normal"
									>
										<span className="flex flex-wrap items-center gap-1.5">
											<span className="text-xs font-medium">{library.name}</span>
											{library.installed ? (
												<Badge
													variant="outline"
													className="h-4 gap-1 px-1 text-[10px] text-success"
												>
													<Check className="h-2.5 w-2.5" />
													{t("testGeneration:libraries.installed")}
												</Badge>
											) : (
												picked && (
													<Badge
														variant="outline"
														className="h-4 px-1 text-[10px] text-warning"
													>
														{t("testGeneration:libraries.toAdd")}
													</Badge>
												)
											)}
										</span>
										<span className="block break-all font-mono text-[10px] text-muted-foreground">
											{library.package}
										</span>
									</Label>
								</div>
							);
						})}
					</div>
				))}
			</div>

			{missing.length > 0 && (
				<div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-2">
					<p className="text-xs text-muted-foreground">
						{t("testGeneration:libraries.missingWarning", {
							count: missing.length,
							packages: missing.map((library) => library.package).join(", "),
						})}
					</p>
					{selection.installCommands.length > 0 && (
						<pre className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground">
							{selection.installCommands.join("\n")}
						</pre>
					)}
					{canInstall && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={onAddPackages}
							disabled={installing}
						>
							{installing ? (
								<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
							) : (
								<PackagePlus className="mr-1.5 h-3.5 w-3.5" />
							)}
							{t("testGeneration:libraries.addPackages", {
								count: missing.length,
							})}
						</Button>
					)}
				</div>
			)}

			{report && (
				<div className="space-y-1 text-xs">
					<p className={report.ok ? "text-success" : "text-destructive"}>
						{report.ok
							? t("testGeneration:libraries.installDone", {
									count: report.installed.length,
									target: report.target,
								})
							: t("testGeneration:libraries.installFailed")}
					</p>
					{report.steps
						.filter((step) => !step.ok)
						.map((step) => (
							<pre
								key={step.command.join(" ")}
								className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground"
							>
								{step.output}
							</pre>
						))}
					{report.manualCommands.length > 0 && (
						<>
							<p className="text-muted-foreground">
								{t("testGeneration:libraries.runByHand")}
							</p>
							<pre className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground">
								{report.manualCommands.join("\n")}
							</pre>
						</>
					)}
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}
