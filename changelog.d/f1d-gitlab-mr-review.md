---
section: 🐛 Corrections
---

- **Revue IA d'une merge request GitLab** : une même MR n'est revue qu'une fois à la fois. Annuler arrête aussi les processus lancés par le runner, et les tue s'ils sont encore là une seconde plus tard. Une revue annulée ne retire plus l'entrée d'une revue relancée après elle. Le nombre de nouveaux commits depuis la revue se compte sur les 100 derniers commits, et non plus sur la première page de 20. Un `GITLAB_REBASE_TIMEOUT_MS` invalide retombe sur 60 s. Les handlers revérifient ce que le renderer envoie avant de l'utiliser : iid de MR, méthode de fusion, identifiants d'assignés, texte de note et findings à publier (`mr-ipc-guard.ts`). Le canal `GITLAB_MR_GET_DIFF`, que l'UI n'appelait pas, est supprimé.
