import { ImagePlus, X } from "lucide-react";
import {
	type ChangeEvent,
	type DragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { DesignBounds } from "../../../../shared/types/design-to-code";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";

const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const MAX_BYTES = 20 * 1024 * 1024;

interface Region {
	name: string;
	bounds: DesignBounds;
}

/**
 * The design: a drop zone until there is one, then the picture with the
 * zones the vision step recognised drawn on it. The zones of the file shown
 * in the inspector light up.
 */
export function SourceColumn() {
	const { t } = useTranslation("designToCode");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [rejected, setRejected] = useState<string | null>(null);

	const imagePreview = useDesignToCodeStore((s) => s.imagePreview);
	const imageName = useDesignToCodeStore((s) => s.imageName);
	const setImageData = useDesignToCodeStore((s) => s.setImageData);
	const clearImage = useDesignToCodeStore((s) => s.clearImage);
	const phase = useDesignToCodeStore((s) => s.phase);
	const liveSpec = useDesignToCodeStore((s) => s.live.spec);
	const resultSpec = useDesignToCodeStore((s) => s.result?.design_spec ?? null);
	const selectedFilePath = useDesignToCodeStore((s) => s.selectedFilePath);
	const sourceType = useDesignToCodeStore((s) => s.sourceType);

	const handleFile = useCallback(
		(file: File) => {
			if (!ACCEPTED.includes(file.type)) {
				setRejected(t("upload.rejectedType"));
				return;
			}
			if (file.size > MAX_BYTES) {
				setRejected(t("upload.rejectedSize"));
				return;
			}
			setRejected(null);
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				setImageData(dataUrl, dataUrl, file.name);
			};
			reader.readAsDataURL(file);
		},
		[setImageData, t],
	);

	// Paste a screenshot from the clipboard anywhere on the page.
	useEffect(() => {
		const onPaste = (event: ClipboardEvent) => {
			const item = Array.from(event.clipboardData?.items ?? []).find((i) =>
				i.type.startsWith("image/"),
			);
			const file = item?.getAsFile();
			if (file) handleFile(file);
		};
		globalThis.addEventListener("paste", onPaste);
		return () => globalThis.removeEventListener("paste", onPaste);
	}, [handleFile]);

	const onDrop = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setDragging(false);
		const file = event.dataTransfer.files[0];
		if (file) handleFile(file);
	};
	const onInput = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (file) handleFile(file);
		event.target.value = "";
	};

	const spec = resultSpec
		? resultSpec.components.map((c) => ({ name: c.name, bounds: c.bounds ?? null }))
		: (liveSpec?.components ?? []).map((c) => ({ name: c.name, bounds: c.bounds ?? null }));
	const regions: Region[] = spec.filter((c): c is Region => Boolean(c.bounds));
	const hotName = selectedFilePath
		? selectedFilePath.split("/").pop()?.split(".")[0]?.toLowerCase()
		: null;
	const palette = resultSpec?.color_palette ?? liveSpec?.palette ?? {};
	const typography = resultSpec?.typography ?? liveSpec?.typography ?? {};
	const running = !["idle", "complete", "error"].includes(phase);
	const firstFont = Object.values(typography)[0];

	return (
		<section className="di-col" aria-label={t("source.kicker")}>
			<div className="di-colhead">
				<div>
					<div className="di-kicker">{t("source.kicker")}</div>
					<h2>{t("source.title")}</h2>
				</div>
				{imagePreview && spec.length > 0 && (
					<span className="di-sub">{t("source.zones", { count: spec.length })}</span>
				)}
				{imagePreview && running && spec.length === 0 && (
					<span className="di-sub">{t("source.reading")}</span>
				)}
			</div>

			<input
				ref={fileInputRef}
				type="file"
				accept={ACCEPTED.join(",")}
				className="hidden"
				onChange={onInput}
				data-testid="design-file-input"
			/>

			{imagePreview ? (
				<div className="di-shot">
					<div className="di-shot-bar">
						<span className="di-shot-name">{imageName}</span>
						<span className="di-chip">{t(`sourceTypes.${sourceType}`)}</span>
						<button
							type="button"
							className="ml-auto"
							onClick={clearImage}
							disabled={running}
							aria-label={t("source.remove")}
							title={t("source.remove")}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
					<div className="di-shot-frame">
						<div className="di-shot-image">
							<img src={imagePreview} alt={t("source.previewAlt")} />
							{regions.map((r) => (
								<div
									key={r.name}
									className="di-region"
									data-hot={hotName === r.name.toLowerCase()}
									style={{
										left: `${r.bounds.x * 100}%`,
										top: `${r.bounds.y * 100}%`,
										width: `${r.bounds.w * 100}%`,
										height: `${r.bounds.h * 100}%`,
										["--di-rc" as string]:
											hotName === r.name.toLowerCase()
												? "var(--di-code)"
												: "var(--di-spec)",
									}}
								>
									<b>{r.name}</b>
								</div>
							))}
							{running && spec.length === 0 && <div className="di-scan" />}
						</div>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="di-drop"
					data-dragging={dragging}
					onClick={() => fileInputRef.current?.click()}
					onDrop={onDrop}
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
				>
					<span className="di-drop-glyph">
						<ImagePlus className="h-7 w-7" />
					</span>
					<span className="di-drop-title">{t("upload.dropDesign")}</span>
					<span className="di-drop-text">{t("upload.dropDescription")}</span>
					<span className="flex flex-wrap justify-center gap-2">
						<span className="di-btn">{t("upload.browse")}</span>
						<span className="di-btn">
							{t("upload.paste")} <kbd>{t("upload.pasteKey")}</kbd>
						</span>
					</span>
					<span className="di-mono di-faint text-3xs">{t("upload.dropFormats")}</span>
				</button>
			)}

			{rejected && (
				<div className="di-banner mt-3" data-kind="error" role="alert">
					{rejected}
				</div>
			)}

			{(Object.keys(palette).length > 0 || firstFont) && (
				<div className="di-facts">
					<div className="di-card di-fact" style={{ ["--di-accent" as string]: "var(--di-tokens)" }}>
						<div className="di-kicker">{t("source.palette")}</div>
						<div className="di-swatches">
							{Object.entries(palette)
								.slice(0, 8)
								.map(([name, value]) => (
									<i
										key={name}
										title={`${name} ${value}`}
										style={{ background: value.startsWith("var(") ? undefined : value }}
									/>
								))}
						</div>
					</div>
					<div className="di-card di-fact" style={{ ["--di-accent" as string]: "var(--di-tokens)" }}>
						<div className="di-kicker">{t("source.typography")}</div>
						{firstFont && (
							<div className="di-mono di-muted mt-1 truncate text-2xs">
								{Object.values(firstFont).slice(0, 3).join(" · ")}
							</div>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
