/**
 * « Copier le chemin » : copie le chemin tel que le bureau de l'utilisateur le
 * nomme. Sous WSL, l'app voit `/home/x/projet/f.cs` mais l'Explorateur Windows
 * attend `\\wsl.localhost\<distro>\home\x\projet\f.cs` : le main fait la
 * traduction (`toHostPath`). Sans main (navigateur) ou en cas d'échec, le
 * chemin part tel quel.
 */
export async function hostPath(path: string): Promise<string> {
	try {
		const translated = await globalThis.electronAPI?.toHostPath?.(path);
		return translated || path;
	} catch {
		return path;
	}
}

export async function copyPath(path: string): Promise<void> {
	await navigator.clipboard.writeText(await hostPath(path));
}
