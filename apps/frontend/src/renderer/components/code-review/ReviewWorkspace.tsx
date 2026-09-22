import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ArrowDown,
	ArrowUp,
	Check,
	Copy,
	FileCode2,
	GitCompareArrows,
	Loader2,
	Plus,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import type {
	ReviewFileData,
	ReviewFileEntry,
	ReviewScope,
} from "../../../shared/types/code-review";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { CodeEditor } from "../ui/code-editor";
import { DiffViewer } from "../ui/diff-viewer";
import { ResizablePanels } from "../ui/resizable-panels";
import { ReviewResults, type ReviewResult } from "./ReviewResults";
import {
	excerpt,
	excerptMarkdown,
	excerptPatch,
	type LineSelection,
} from "./excerpts";
interface Props {
	projectId: string;
	onReview: (diff: string) => void;
	loading: boolean;
	result: ReviewResult | null;
	error: string | null;
}
interface ReviewItem {
	snapshot: ReviewFileData;
	id: string;
	file: string;
	label: string;
	patch: string;
}
export function ReviewWorkspace({
	projectId,
	onReview,
	loading,
	result,
	error,
}: Props) {
	const { t } = useTranslation("codeReview");
	const container = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	const [panel, setPanel] = useState<"files" | "code" | "review">("files");
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const observer = new ResizeObserver((entries) =>
			setCompact(entries[0].contentRect.width < 1000),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const [files, setFiles] = useState<ReviewFileEntry[]>([]);
	const [query, setQuery] = useState("");
	const [searchRequest, setSearchRequest] = useState(0);
	const [modified, setModified] = useState(false);
	const [checked, setChecked] = useState<string[]>([]);
	const [tabs, setTabs] = useState<string[]>([]);
	const [active, setActive] = useState("");
	const [scope, setScope] = useState<ReviewScope>("all");
	const [view, setView] = useState<"code" | "diff">("code");
	const [split, setSplit] = useState(true);
	const [file, setFile] = useState<ReviewFileData | null>(null);
	const [snapshot, setSnapshot] = useState<ReviewFileData | null>(null);
	const [selection, setSelection] = useState<LineSelection | null>(null);
	const [revealLine, setRevealLine] = useState<number>();
	const [navigation, setNavigation] = useState(0);
	const [items, setItems] = useState<ReviewItem[]>([]);
	const [manual, setManual] = useState("");
	const [reviewedPayload, setReviewedPayload] = useState<string | null>(null);
	const [source, setSource] = useState<"project" | "paste">("project");
	const [listing, setListing] = useState(false);
	const [reading, setReading] = useState(false);
	const [adding, setAdding] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [limit, setLimit] = useState(200);
	const search = useRef<HTMLInputElement>(null);
	const diffContainer = useRef<HTMLDivElement>(null);
	const generation = useRef(0);
	const hunk = useRef(-1);
	useEffect(() => {
		if (searchRequest) search.current?.focus();
	}, [searchRequest]);
	useEffect(() => {
		const current = ++generation.current;
		setFiles([]);
		setTabs([]);
		setActive("");
		setFile(null);
		setChecked([]);
		setItems([]);
		setManual("");
		setLocalError(null);
		setListing(true);
		window.electronAPI
			.listReviewFiles(projectId)
			.then((response) => {
				if (current !== generation.current) return;
				if (!response.success || !response.data)
					throw new Error(response.error || t("workspace.loadFailed"));
				setFiles(response.data);
			})
			.catch((e) => {
				if (current === generation.current)
					setLocalError(String(e.message || e));
			})
			.finally(() => {
				if (current === generation.current) setListing(false);
			});
		return () => {
			generation.current++;
		};
	}, [projectId, t]);
	useEffect(() => {
		if (!refresh) return;
		let cancelled = false;
		setListing(true);
		setLocalError(null);
		window.electronAPI
			.listReviewFiles(projectId)
			.then((response) => {
				if (cancelled) return;
				if (!response.success || !response.data)
					throw new Error(response.error || t("workspace.loadFailed"));
				setFiles(response.data);
				setChecked((previous) =>
					previous.filter((path) =>
						response.data?.some((entry) => entry.path === path),
					),
				);
			})
			.catch((e) => {
				if (!cancelled) setLocalError(String(e.message || e));
			})
			.finally(() => {
				if (!cancelled) setListing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [refresh, projectId, t]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads the same active file from disk
	useEffect(() => {
		let cancelled = false;
		setFile(null);
		setSelection(null);
		setCopied(false);
		hunk.current = -1;
		if (!active) {
			setReading(false);
			return;
		}
		if (snapshot && snapshot.path === active) {
			setFile(snapshot);
			setReading(false);
			if (snapshot.unavailable === "deleted") setView("diff");
			return;
		}
		setReading(true);
		setLocalError(null);
		window.electronAPI
			.readReviewFile(projectId, active, scope)
			.then((response) => {
				if (cancelled) return;
				if (!response.success || !response.data)
					throw new Error(response.error || t("workspace.loadFailed"));
				setFile(response.data);
				if (response.data.unavailable === "deleted") setView("diff");
			})
			.catch((e) => {
				if (!cancelled) setLocalError(String(e.message || e));
			})
			.finally(() => {
				if (!cancelled) setReading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, active, scope, refresh, snapshot, t]);
	const payload =
		source === "paste" ? manual : items.map((item) => item.patch).join("\n");
	const payloadBytes = new TextEncoder().encode(payload).byteLength;
	const canReview =
		Boolean(payload.trim()) &&
		!loading &&
		!adding &&
		payloadBytes <= 2 * 1024 * 1024;
	function runReview() {
		if (canReview) {
			setPanel("review");
			setReviewedPayload(payload);
			onReview(payload);
		}
	}
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			if (event.key.toLowerCase() === "p") {
				event.preventDefault();
				setPanel("files");
				setSource("project");
				setSearchRequest((value) => value + 1);
			}
			if (event.key === "Enter") {
				event.preventDefault();
				if (canReview) {
					setPanel("review");
					setReviewedPayload(payload);
					onReview(payload);
				}
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [canReview, onReview, payload]);
	function open(path: string, line?: number, reviewedFile?: ReviewFileData) {
		setSnapshot(reviewedFile ?? null);
		setPanel("code");
		setSource("project");
		setTabs((previous) =>
			previous.includes(path) ? previous : [...previous, path],
		);
		setActive(path);
		setSelection(null);
		setRevealLine(line);
		if (line) setNavigation((value) => value + 1);
		if (line) setView("code");
	}
	function addItem(
		data: ReviewFileData,
		selected?: LineSelection | null,
		asDiff = false,
	) {
		if (data.unavailable && !(asDiff && data.patch)) return;
		const patch = asDiff
			? data.patch
			: excerptPatch(data.path, data.content, selected);
		if (!patch.trim()) return;
		const range = excerpt(data.content, selected);
		const label = asDiff
			? t(`workspace.scope.${scope}`)
			: `${range.start}–${range.end}`;
		const id = `${data.path}:${asDiff ? scope : label}`;
		setItems((previous) => [
			...previous.filter(
				(item) =>
					item.id !== id &&
					(item.file !== data.path || item.snapshot.content === data.content),
			),
			{ id, file: data.path, label, patch, snapshot: data },
		]);
	}
	async function addChecked() {
		const current = generation.current;
		setAdding(true);
		setLocalError(null);
		try {
			for (const name of checked) {
				const response = await window.electronAPI.readReviewFile(
					projectId,
					name,
					scope,
				);
				if (current !== generation.current) return;
				if (!response.success || !response.data)
					throw new Error(response.error || t("workspace.loadFailed"));
				if (response.data.unavailable && !response.data.patch)
					throw new Error(
						`${name}: ${t(`workspace.${response.data.unavailable}`)}`,
					);
				addItem(
					response.data,
					null,
					view === "diff" || response.data.unavailable === "deleted",
				);
			}
		} catch (e) {
			if (current === generation.current)
				setLocalError(e instanceof Error ? e.message : String(e));
		} finally {
			if (current === generation.current) setAdding(false);
		}
	}
	async function copy(markdown: boolean) {
		if (!file) return;
		try {
			await navigator.clipboard.writeText(
				markdown
					? excerptMarkdown(file.path, file.content, selection)
					: view === "diff"
						? file.patch
						: excerpt(file.content, selection).code,
			);
			setCopied(true);
		} catch {
			setLocalError(t("workspace.copyFailed"));
		}
	}
	function moveHunk(direction: number) {
		const nodes = Array.from(
			diffContainer.current?.querySelectorAll<HTMLElement>(
				"[data-diff-hunk]",
			) ?? [],
		);
		if (!nodes.length) return;
		hunk.current = (hunk.current + direction + nodes.length) % nodes.length;
		nodes[hunk.current].scrollIntoView({ block: "center", behavior: "smooth" });
	}
	const filtered = files.filter(
		(entry) =>
			(!modified || entry.status.trim()) &&
			entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
	);
	const explorer = (
		<div className="flex h-full min-w-0 flex-col bg-card/60">
			<div className="space-y-3 border-b p-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">{t("workspace.files")}</h2>
					<span className="text-xs text-muted-foreground">{files.length}</span>
				</div>
				<div className="relative">
					<Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
					<Input
						ref={search}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setLimit(200);
						}}
						aria-label={t("workspace.search")}
						placeholder={t("workspace.search")}
						className="h-9 pl-8"
					/>
				</div>
				<div className="flex gap-1">
					{[false, true].map((value) => (
						<Button
							key={String(value)}
							size="sm"
							variant={modified === value ? "secondary" : "ghost"}
							onClick={() => setModified(value)}
						>
							{t(value ? "workspace.modified" : "workspace.allFiles")}
						</Button>
					))}
				</div>
			</div>
			<div className="flex-1 overflow-auto p-2">
				{listing ? (
					<p role="status" className="p-3 text-sm text-muted-foreground">
						{t("workspace.loading")}
					</p>
				) : filtered.length === 0 ? (
					<p className="p-3 text-sm text-muted-foreground">
						{t("workspace.noFiles")}
					</p>
				) : (
					filtered.slice(0, limit).map((entry) => (
						<div
							key={entry.path}
							className={cn(
								"group flex items-center gap-2 rounded-md px-2 hover:bg-secondary",
								active === entry.path && "bg-primary/10 text-primary",
							)}
						>
							<input
								type="checkbox"
								checked={checked.includes(entry.path)}
								aria-label={t("workspace.selectFile", { file: entry.path })}
								onChange={(e) =>
									setChecked((previous) =>
										e.target.checked
											? [...previous, entry.path]
											: previous.filter((path) => path !== entry.path),
									)
								}
							/>
							<button
								type="button"
								title={entry.path}
								onClick={() => open(entry.path)}
								className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-xs"
							>
								<FileCode2 className="h-4 w-4 shrink-0 opacity-60" />
								<span className="truncate">{entry.path}</span>
							</button>
							<span
								className="shrink-0 font-mono text-[10px] text-amber-500"
								title={t("workspace.gitStatus")}
							>
								{entry.status.trim()}
							</span>
						</div>
					))
				)}
				{filtered.length > limit && (
					<Button
						variant="ghost"
						onClick={() => setLimit((previous) => previous + 200)}
					>
						{t("workspace.showMore")}
					</Button>
				)}
			</div>
			<div className="border-t p-3">
				<Button
					className="w-full"
					size="sm"
					variant="secondary"
					disabled={!checked.length || adding}
					onClick={addChecked}
				>
					{adding ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Plus className="mr-2 h-4 w-4" />
					)}
					{t("workspace.addFiles", { count: checked.length })}
				</Button>
			</div>
		</div>
	);
	const editor = (
		<div className="flex h-full min-w-0 flex-col">
			<div className="flex shrink-0 overflow-x-auto border-b bg-secondary/20">
				{tabs.map((path) => (
					<div
						key={path}
						className={cn(
							"flex max-w-64 shrink-0 items-center border-r border-b-2",
							active === path
								? "border-b-primary bg-background"
								: "border-b-transparent",
						)}
					>
						<button
							type="button"
							className="truncate px-3 py-3 text-xs"
							title={path}
							onClick={() => open(path)}
						>
							{path.split("/").at(-1)}
						</button>
						<button
							type="button"
							className="p-2 hover:text-primary"
							aria-label={t("workspace.closeFile", { file: path })}
							onClick={() => {
								setTabs((previous) => previous.filter((tab) => tab !== path));
								if (active === path)
									setActive(tabs.find((tab) => tab !== path) ?? "");
							}}
						>
							<X className="h-3 w-3" />
						</button>
					</div>
				))}
			</div>
			{!active ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
					<FileCode2 className="h-12 w-12 opacity-25" />
					<h2 className="font-medium text-foreground">
						{t("workspace.emptyTitle")}
					</h2>
					<p className="max-w-sm text-sm">{t("workspace.emptyHint")}</p>
					<kbd className="rounded border px-2 py-1 text-xs">
						{t("workspace.searchShortcut")}
					</kbd>
				</div>
			) : (
				<>
					<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-2">
						<div className="flex gap-1">
							<Button
								size="sm"
								variant={view === "code" ? "secondary" : "ghost"}
								onClick={() => setView("code")}
							>
								{t("workspace.code")}
							</Button>
							<Button
								size="sm"
								variant={view === "diff" ? "secondary" : "ghost"}
								onClick={() => setView("diff")}
							>
								<GitCompareArrows className="mr-1 h-4 w-4" />
								{t("workspace.diff")}
							</Button>
						</div>
						{view === "diff" && (
							<div className="flex items-center gap-1">
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setSplit(!split)}
								>
									{t(split ? "workspace.split" : "workspace.unified")}
								</Button>
								<Button
									size="icon"
									variant="ghost"
									aria-label={t("workspace.previousChange")}
									onClick={() => moveHunk(-1)}
								>
									<ArrowUp className="h-4 w-4" />
								</Button>
								<Button
									size="icon"
									variant="ghost"
									aria-label={t("workspace.nextChange")}
									onClick={() => moveHunk(1)}
								>
									<ArrowDown className="h-4 w-4" />
								</Button>
							</div>
						)}
					</div>
					<div
						className="truncate border-b px-3 py-2 font-mono text-[11px] text-muted-foreground"
						title={active}
					>
						{snapshot && (
							<span className="mr-2 rounded bg-primary/10 px-2 py-0.5 font-sans text-primary">
								{t("workspace.reviewedSnapshot")}
							</span>
						)}
						{active}
					</div>
					<div className="min-h-0 flex-1 overflow-auto" ref={diffContainer}>
						{reading ? (
							<div
								role="status"
								className="flex items-center gap-2 p-6 text-sm"
							>
								<Loader2 className="h-4 w-4 animate-spin" />
								{t("workspace.loading")}
							</div>
						) : (
							file &&
							(file.unavailable &&
							!(file.unavailable === "deleted" && view === "diff") ? (
								<p className="p-6 text-sm text-muted-foreground">
									{t(`workspace.${file.unavailable}`)}
								</p>
							) : view === "diff" ? (
								<DiffViewer
									patch={file.patch}
									viewMode={split ? "split" : "unified"}
								/>
							) : (
								<CodeEditor
									key={`${active}:${navigation}`}
									value={file.content}
									filename={active}
									readOnly
									onSelectionChange={(value) => {
										setSelection(value);
										setCopied(false);
									}}
									revealLine={revealLine}
									className="rounded-none border-0"
								/>
							))
						)}
					</div>
					<div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card p-3">
						<span className="mr-auto text-xs text-muted-foreground">
							{selection
								? t("workspace.selectedLines", { ...selection })
								: t("workspace.selectionHint")}
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={
								!file ||
								(view === "diff" ? !file.patch : Boolean(file.unavailable))
							}
							onClick={() => copy(false)}
						>
							{copied ? (
								<Check className="mr-1 h-4 w-4" />
							) : (
								<Copy className="mr-1 h-4 w-4" />
							)}
							{t("workspace.copy")}
						</Button>
						{view === "code" && (
							<Button
								size="sm"
								variant="outline"
								disabled={!file || Boolean(file.unavailable)}
								onClick={() => copy(true)}
							>
								{t("workspace.extract")}
							</Button>
						)}
						<Button
							size="sm"
							disabled={
								!file ||
								reading ||
								(view === "diff" ? !file.patch : Boolean(file.unavailable))
							}
							onClick={() => file && addItem(file, selection, view === "diff")}
						>
							<Plus className="mr-1 h-4 w-4" />
							{t(
								view === "diff"
									? "workspace.addDiff"
									: selection
										? "workspace.addSelection"
										: "workspace.addFile",
							)}
						</Button>
					</div>
				</>
			)}
		</div>
	);
	const sidebar = (
		<aside className="flex h-full min-w-0 flex-col bg-card/50">
			<div className="space-y-3 border-b p-4">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">
						{t("workspace.reviewBasket")}
					</h2>
					<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
						{items.length}
					</span>
				</div>
				<p className="text-xs text-muted-foreground">
					{t("workspace.snapshotHint")}
				</p>
				{source === "project" && (
					<div className="max-h-48 space-y-1 overflow-auto">
						{items.length === 0 ? (
							<p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
								{t("workspace.basketEmpty")}
							</p>
						) : (
							items.map((item) => (
								<div
									key={item.id}
									className="flex items-center gap-2 rounded-lg border bg-background px-2 py-2"
								>
									<button
										type="button"
										className="min-w-0 flex-1 text-left text-xs"
										title={item.file}
										onClick={() => open(item.file)}
									>
										<span className="block truncate font-medium">
											{item.file}
										</span>
										<span className="text-muted-foreground">{item.label}</span>
									</button>
									<button
										type="button"
										className="p-1"
										aria-label={t("workspace.remove", { file: item.file })}
										onClick={() =>
											setItems((previous) =>
												previous.filter((entry) => entry.id !== item.id),
											)
										}
									>
										<X className="h-4 w-4" />
									</button>
								</div>
							))
						)}
					</div>
				)}
				{payloadBytes > 2 * 1024 * 1024 && (
					<p role="alert" className="text-xs text-destructive">
						{t("workspace.tooMuch")}
					</p>
				)}
				<Button className="w-full" disabled={!canReview} onClick={runReview}>
					{loading ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<GitCompareArrows className="mr-2 h-4 w-4" />
					)}
					{t(loading ? "actions.analyzing" : "actions.runReview")}
				</Button>
				<p className="text-center text-[10px] text-muted-foreground">
					{t("workspace.reviewShortcut")}
				</p>
			</div>
			<div className="flex-1 overflow-auto p-4">
				{error && reviewedPayload === payload && (
					<p
						role="alert"
						className="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
					>
						{error}
					</p>
				)}
				{result && reviewedPayload === payload ? (
					<ReviewResults
						result={result}
						onNavigate={(path, line) =>
							open(
								path,
								line,
								items.find((item) => item.file === path)?.snapshot,
							)
						}
					/>
				) : (
					<p className="py-8 text-center text-sm text-muted-foreground">
						{t("workspace.resultsHint")}
					</p>
				)}
			</div>
		</aside>
	);
	return (
		<div ref={container} className="flex h-full min-h-0 flex-col bg-background">
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
				<div className="flex items-center gap-3">
					<div className="rounded-xl bg-primary/10 p-2.5">
						<GitCompareArrows className="h-5 w-5 text-primary" />
					</div>
					<div>
						<h1 className="text-lg font-semibold">{t("title")}</h1>
						<p className="text-xs text-muted-foreground">
							{t("workspace.subtitle")}
						</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						variant={source === "project" ? "secondary" : "ghost"}
						onClick={() => setSource("project")}
					>
						{t("workspace.project")}
					</Button>
					<Button
						size="sm"
						variant={source === "paste" ? "secondary" : "ghost"}
						onClick={() => {
							setSource("paste");
							setPanel("code");
						}}
					>
						{t("workspace.paste")}
					</Button>
					<select
						aria-label={t("workspace.comparison")}
						value={scope}
						onChange={(e) => {
							setSnapshot(null);
							setScope(e.target.value as ReviewScope);
						}}
						className="h-9 max-w-52 rounded-md border bg-background px-2 text-xs"
					>
						{(["all", "staged", "working"] as const).map((value) => (
							<option key={value} value={value}>
								{t(`workspace.scope.${value}`)}
							</option>
						))}
					</select>
					<Button
						size="icon"
						variant="outline"
						disabled={listing}
						aria-label={t("workspace.refresh")}
						onClick={() => {
							setSnapshot(null);
							setRefresh((value) => value + 1);
						}}
					>
						<RefreshCw className={cn("h-4 w-4", listing && "animate-spin")} />
					</Button>
				</div>
			</header>
			{localError && (
				<div
					role="alert"
					className="flex items-center justify-between gap-3 bg-destructive/10 px-5 py-2 text-sm text-destructive"
				>
					<span>{localError}</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setSnapshot(null);
							setRefresh((value) => value + 1);
						}}
					>
						{t("workspace.retry")}
					</Button>
				</div>
			)}
			{compact && (
				<nav
					aria-label={t("workspace.panels")}
					className="flex gap-2 border-b p-2"
				>
					{(["files", "code", "review"] as const).map((name) => (
						<Button
							key={name}
							size="sm"
							variant={panel === name ? "secondary" : "ghost"}
							aria-pressed={panel === name}
							onClick={() => setPanel(name)}
						>
							{t(`workspace.panel.${name}`)}
							{name === "review" && items.length > 0
								? ` (${items.length})`
								: ""}
						</Button>
					))}
				</nav>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				{compact ? (
					panel === "review" ? (
						sidebar
					) : source === "paste" ? (
						<Textarea
							aria-label={t("input.label")}
							value={manual}
							onChange={(e) => setManual(e.target.value)}
							placeholder={t("input.placeholder")}
							className="h-full font-mono"
						/>
					) : panel === "files" ? (
						explorer
					) : (
						editor
					)
				) : (
					<ResizablePanels
						className="h-full min-h-[480px]"
						defaultLeftWidth={74}
						minLeftWidth={45}
						maxLeftWidth={85}
						storageKey="code-review-main-width"
						leftPanel={
							source === "paste" ? (
								<div className="flex h-full flex-col gap-3 p-5">
									<h2 className="font-medium">{t("input.label")}</h2>
									<Textarea
										value={manual}
										onChange={(e) => setManual(e.target.value)}
										placeholder={t("input.placeholder")}
										className="min-h-64 flex-1 font-mono text-xs"
									/>
								</div>
							) : (
								<ResizablePanels
									className="h-full"
									defaultLeftWidth={27}
									minLeftWidth={18}
									maxLeftWidth={45}
									storageKey="code-review-files-width"
									leftPanel={explorer}
									rightPanel={editor}
								/>
							)
						}
						rightPanel={sidebar}
					/>
				)}
			</div>
		</div>
	);
}
