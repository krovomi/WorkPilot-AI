---
section: ✨ Nouveautés
---

- **L'agent d'accessibilité note le projet, ouvre l'application lancée et corrige sur une branche de revue** (F192). Les règles WCAG 2.2 lisent toutes les stacks de la même façon (HTML, JSX/TSX, Vue, Svelte, Astro, Angular, Razor/Blazor, PHP/Blade, Twig, ERB, Handlebars, et le CSS) et se taisent quand la source ne sait pas (attribut lié, props étalées, composant inconnu) ; nouvelles règles de contraste, focus visible, taille des cibles, titres, langue, rôles ARIA, zoom. Un score de 0 à 100 par critère et par page, avec son historique ; le scan dynamique (App Emulator ou localhost) parcourt la page au clavier et lit l'arbre d'accessibilité ; les corrections simples (alt, aria-label, lang) se font sur une carte de revue, jamais dans le dossier ; export HTML, CSV et PDF ; Import Design affiche le score du code généré (#391).
