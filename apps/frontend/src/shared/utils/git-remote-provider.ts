/**
 * Which forge a git remote points at, read from its host.
 *
 * A pattern searched anywhere in the URL (`/github\.com/`) also matches
 * `https://evil.example/github.com/x` or `github.com.evil.example`; the host
 * is compared whole, or as a subdomain of the forge's domain.
 */

export type RemoteProvider = "github" | "gitlab" | "azure_devops" | "unknown";

/** The lower-cased host of `https://host/…`, `ssh://user@host:22/…` or `user@host:path`. */
export function gitRemoteHost(url: string): string {
	const match = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)/i);
	return match?.[1]?.toLowerCase() ?? "";
}

function isDomainOrSubdomain(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

export function providerFromRemoteUrl(url: string): RemoteProvider {
	const host = gitRemoteHost(url);
	if (isDomainOrSubdomain(host, "github.com")) return "github";
	// gitlab.com itself; a self-hosted instance is known by the host its
	// project settings name (`gitlabProjectOfRemote`), not guessed from a name.
	if (isDomainOrSubdomain(host, "gitlab.com")) return "gitlab";
	if (
		isDomainOrSubdomain(host, "dev.azure.com") ||
		isDomainOrSubdomain(host, "visualstudio.com")
	)
		return "azure_devops";
	return "unknown";
}
