import {
	CheckCircle,
	Copy,
	FileText,
	Image as ImageIcon,
	Loader2,
	Save,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Factory function to create markdown components with projectPath
const createMarkdownComponents = (projectPath?: string): Components => ({
	img: ({ src, alt }) => (
		<MarkdownImage src={src} alt={alt} projectPath={projectPath} />
	),
});

// Component for handling markdown images with local image support
const MarkdownImage = ({
	src,
	alt,
	projectPath,
}: {
	src?: string;
	alt?: string;
	projectPath?: string;
}) => {
	return (
		<LocalImage src={src || ""} alt={alt || ""} projectPath={projectPath} />
	);
};

// Component for loading local images via IPC
interface LocalImageProps {
	readonly src: string;
	readonly alt: string;
	readonly projectPath?: string;
}

function LocalImage({ src, alt, projectPath }: LocalImageProps) {
	const { t } = useTranslation();
	const [imageSrc, setImageSrc] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// If it's already an absolute URL or data URL, use it directly
		if (
			src.startsWith("http://") ||
			src.startsWith("https://") ||
			src.startsWith("data:")
		) {
			setImageSrc(src);
			setLoading(false);
			return;
		}

		// If no project path, we can't load local images
		if (!projectPath) {
			setError("Cannot load local image: no project path");
			setLoading(false);
			return;
		}

		// Load local image via IPC
		const loadImage = async () => {
			try {
				setLoading(true);
				setError(null);
				// Handle relative paths like .github/assets/... or ./path/to/image
				const relativePath = src.startsWith("./") ? src.slice(2) : src;
				const result = await globalThis.electronAPI.readLocalImage(
					projectPath,
					relativePath,
				);
				if (result.success && result.data) {
					setImageSrc(result.data);
				} else {
					setError(result.error || "Failed to load image");
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to load image");
			} finally {
				setLoading(false);
			}
		};

		loadImage();
	}, [src, projectPath]);

	if (loading) {
		return (
			<span className="inline-flex items-center gap-2 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				<span>{t("changelog:previewPanel.loadingImage")}</span>
			</span>
		);
	}

	if (error || !imageSrc) {
		return (
			<span className="inline-flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				<ImageIcon className="h-4 w-4" />
				<span>{error || t("changelog:previewPanel.imageNotFound")}</span>
			</span>
		);
	}

	return <img src={imageSrc} alt={alt} className="max-w-full h-auto" />;
}

interface PreviewPanelProps {
	readonly generatedChangelog: string;
	readonly saveSuccess: boolean;
	readonly copySuccess: boolean;
	readonly canSave: boolean;
	readonly isDragOver: boolean;
	readonly imageError: string | null;
	readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	readonly projectPath?: string;
	readonly onSave: () => void;
	readonly onCopy: () => void;
	readonly onChangelogEdit: (content: string) => void;
	readonly onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	readonly onDragOver: (e: React.DragEvent) => void;
	readonly onDragLeave: (e: React.DragEvent) => void;
	readonly onDrop: (e: React.DragEvent) => void;
	/** A server project: the changelog is kept on the server, not in a file. */
	readonly serverProject?: boolean;
}

export function PreviewPanel({
	generatedChangelog,
	saveSuccess,
	copySuccess,
	canSave,
	isDragOver,
	imageError,
	textareaRef,
	projectPath,
	onSave,
	onCopy,
	onChangelogEdit,
	onPaste,
	onDragOver,
	onDragLeave,
	onDrop,
	serverProject = false,
}: PreviewPanelProps) {
	const { t } = useTranslation("changelog");
	const [viewMode, setViewMode] = useState<"markdown" | "preview">("markdown");

	// Custom components for ReactMarkdown to handle local image paths
	const markdownComponents = useMemo(
		() => createMarkdownComponents(projectPath),
		[projectPath],
	);

	return (
		<div className="wp-card flex min-w-0 flex-1 flex-col overflow-hidden">
			{/* Preview Header */}
			<div className="flex items-center justify-between border-b border-border px-4 py-3">
				<div className="flex items-center gap-3">
					<h2 className="font-medium">{t("changelog:previewPanel.preview")}</h2>
					<div className="flex items-center gap-1 rounded-md border border-border p-1">
						<Button
							variant={viewMode === "markdown" ? "default" : "ghost"}
							size="sm"
							onClick={() => setViewMode("markdown")}
							className="h-7 px-3 text-xs"
						>
							Markdown
						</Button>
						<Button
							variant={viewMode === "preview" ? "default" : "ghost"}
							size="sm"
							onClick={() => setViewMode("preview")}
							className="h-7 px-3 text-xs"
						>
							{t("changelog:previewPanel.preview")}
						</Button>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={onCopy}
								disabled={!canSave}
							>
								{copySuccess ? (
									<CheckCircle className="mr-2 h-4 w-4 text-success" />
								) : (
									<Copy className="mr-2 h-4 w-4" />
								)}
								{copySuccess ? t("changelog:previewPanel.copied") : t("changelog:previewPanel.copyShort")}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("changelog:previewPanel.copy")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="default"
								size="sm"
								onClick={onSave}
								disabled={!canSave}
							>
								{saveSuccess ? (
									<CheckCircle className="mr-2 h-4 w-4" />
								) : (
									<Save className="mr-2 h-4 w-4" />
								)}
								{saveSuccess
									? t("changelog:previewPanel.saved")
									: serverProject
										? t("server.save")
										: t("changelog:previewPanel.saveToFile")}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{serverProject
								? t("server.saveTooltip")
								: t("changelog:previewPanel.prepend")}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* Preview Content */}
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drag-and-drop zone */}
			<section
				className={`flex-1 overflow-hidden p-6 ${isDragOver ? "bg-muted/50" : ""}`}
				aria-label={t("changelog:previewPanel.aria")}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				{generatedChangelog ? (
					<>
						{isDragOver && (
							<div className="mb-4 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 p-4 text-center">
								<ImageIcon className="mx-auto h-8 w-8 text-primary/50" />
								<p className="mt-2 text-sm text-primary/70">
									{t("changelog:previewPanel.dropImages")}
								</p>
							</div>
						)}
						{imageError && (
							<div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
								{imageError}
							</div>
						)}
						{viewMode === "markdown" ? (
							<div className="flex h-full flex-col gap-2">
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<ImageIcon className="h-3.5 w-3.5" />
									<span>
										{t("changelog:previewPanel.pasteImages")}
									</span>
								</div>
								<Textarea
									ref={textareaRef}
									className="flex-1 w-full resize-none font-mono text-sm"
									value={generatedChangelog}
									onChange={(e) => onChangelogEdit(e.target.value)}
									onPaste={onPaste}
									placeholder={t("changelog:previewPanel.placeholder")}
								/>
							</div>
						) : (
							<div className="h-full overflow-auto">
								<div className="prose prose-sm dark:prose-invert max-w-none">
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										components={markdownComponents}
									>
										{generatedChangelog}
									</ReactMarkdown>
								</div>
							</div>
						)}
					</>
				) : (
					<div className="flex h-full items-center justify-center">
						<div className="text-center">
							<FileText className="mx-auto h-12 w-12 text-muted-foreground/30" />
							<p className="mt-4 text-sm text-muted-foreground">
								{t("changelog:previewPanel.empty")}
							</p>
							<p className="mt-2 text-xs text-muted-foreground flex items-center justify-center gap-2">
								<ImageIcon className="h-3.5 w-3.5" />
								<span>
									{t("changelog:previewPanel.pasteImages")}
								</span>
							</p>
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
