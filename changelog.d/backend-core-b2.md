---
section: 🧪 Filets de test
---

- **Couverture backend, lot B2a (`core/`)** : la jauge d'usage Copilot (quotas personnels, rapports d'entreprise et d'organisation, droits manquants, `gh` absent ou non connecté, garde des URL de rapport), la session Claude des insights, le fournisseur et le modèle nommés dans les logs, les rapports d'erreur Sentry, les quatre destinations de l'usage d'une session et la lecture du plan par la boucle de build passent à 100 %. Le `gh` des tests est un programme qui répond aux commandes choisies ; la base d'analytics est un vrai fichier SQLite ; Sentry tourne avec le vrai SDK et un transport qui garde ce qu'il aurait envoyé.
- **Rapports d'erreur** : le nom d'utilisateur est masqué dans tout le rapport. Seuls certains champs l'étaient, et les variables locales de chaque frame partaient telles quelles : une erreur levée sur un chemin sous `/home/<nom>/` envoyait ce chemin.
- **Code mort retiré** : `core/optimization` (que rien n'importait), la route d'usage Claude du backend (l'app ne l'appelait pas), les runtimes Copilot et LiteLLM avec `core/llm_client.py` (leur seul appelant demande toujours Claude), le streaming de la session Claude (il échouait au premier message et rien ne l'appelait), `get_plan_summary` et `format_duration`.
- **Copilot détecté dans les logs** : le `gh` est trouvé comme partout ailleurs (réglage de l'app, PATH, dossiers d'installation) ; un `gh` nommé seulement par le réglage de l'app, ou installé en `gh.cmd` sous Windows, n'était pas vu.
