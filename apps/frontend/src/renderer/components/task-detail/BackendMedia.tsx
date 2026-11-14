import type { AnchorHTMLAttributes, ImgHTMLAttributes, VideoHTMLAttributes } from "react";
import { useLocalBackendFile } from "../../hooks/useLocalBackendFile";

/**
 * Files the local backend serves (the verifier's screenshots, video, GIF and
 * trace), shown from a `blob:` URL that main fetched: the page cannot reach
 * the backend itself (no origin it accepts, and the CSP names no such host).
 */

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { readonly src: string };

export function BackendImage({ src, alt, ...rest }: ImageProps) {
	const url = useLocalBackendFile(src);
	return <img src={url} alt={alt} {...rest} />;
}

type VideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & { readonly src: string };

export function BackendVideo({ src, children, ...rest }: VideoProps) {
	const url = useLocalBackendFile(src);
	return (
		<video src={url} {...rest}>
			{children}
		</video>
	);
}

type DownloadProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "download"> & {
	readonly href: string;
	/** The name the file is saved under. */
	readonly fileName: string;
};

/** A link that saves the file (Electron's save dialog), never a new window. */
export function BackendDownloadLink({ href, fileName, children, ...rest }: DownloadProps) {
	const url = useLocalBackendFile(href);
	return (
		<a href={url} download={fileName} aria-disabled={url ? undefined : true} {...rest}>
			{children}
		</a>
	);
}
