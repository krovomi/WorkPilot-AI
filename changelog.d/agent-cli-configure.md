---
section: 🐛 Corrections
---

- **OpenCode, pi, Gemini CLI et Google Antigravity se configurent depuis Comptes.** Le bouton
  « Configurer » ouvrait une fenêtre vide et les cartes restaient « Non configuré » même avec le
  CLI installé. La carte suit maintenant l'installation du CLI, et la fenêtre montre son état
  (avec installation en un clic), ouvre un terminal sur la commande de connexion du CLI
  (`opencode auth login`, `pi` puis `/login`, `agy`, `gemini`) et le définit comme fournisseur
  par défaut.
- **Traductions manquantes.** Les descriptions des cartes de ces quatre CLI s'affichaient en clé
  brute (`sections.accounts.providers.opencode`…). Une centaine d'autres clés absentes ou mal
  nommées sont corrigées en français et en anglais : fournisseur personnalisé, terminal de
  connexion GitHub Copilot, configuration Azure DevOps, initialisation Git, estimation
  intelligente (espace de noms jamais chargé), étape CLI de l'onboarding, etc.
