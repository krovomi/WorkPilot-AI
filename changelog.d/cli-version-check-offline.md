---
section: 🐛 Corrections
---

- **Plus de pile d'erreurs dans les logs quand le registre npm ne répond pas.** La vérification
  de la dernière version de Claude Code, Codex CLI et Copilot CLI écrivait une trace complète
  (`DOMException [TimeoutError]…`) à chaque fois qu'une carte demandait l'état du CLI. Un échec
  réseau donne maintenant une seule ligne courte (`[Codex CLI] Could not check the latest version
  on npm (timed out); next try in 5 min.`), l'app garde la dernière version connue et ne
  réinterroge le registre qu'au bout de 5 minutes. Délai d'attente ramené à 10 s, avec un nouvel
  essai si la connexion est coupée ou si le serveur répond 5xx.
