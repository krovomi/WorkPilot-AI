/**
 * Une tâche touche-t-elle l'interface ? (#383)
 *
 * La revue d'une carte du Kanban ouvre la matrice d'appareils d'office quand
 * le diff de la tâche change ce qu'une page affiche. La réponse se lit sur les
 * chemins du diff, pour tous les stacks web que l'émulateur sert : composants
 * (React, Vue, Svelte, Angular, Astro, Solid), feuilles de style, gabarits
 * serveur (Razor, ERB, Jinja, Twig, Blade, Thymeleaf, EJS, Pug, Liquid…), et
 * Flutter / Dart. Une liste fermée d'extensions, jamais le contenu des fichiers.
 */

/** Les fins de nom de fichier d'une interface web, en minuscules. */
export const UI_FILE_SUFFIXES: readonly string[] = [
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".styl",
	".pcss",
	".jsx",
	".tsx",
	".vue",
	".svelte",
	".astro",
	".mdx",
	".razor",
	".cshtml",
	".vbhtml",
	".aspx",
	".ascx",
	".erb",
	".haml",
	".slim",
	".jinja",
	".jinja2",
	".j2",
	".twig",
	".njk",
	".liquid",
	".hbs",
	".handlebars",
	".mustache",
	".ejs",
	".pug",
	".blade.php",
	".heex",
	".leex",
	".templ",
	".gohtml",
	".tmpl",
	".dart",
];

/** Au moins un fichier du diff change ce qu'une page web affiche. */
export function touchesUserInterface(paths: readonly string[]): boolean {
	return paths.some((path) => {
		const name = path.toLowerCase();
		return UI_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
	});
}
