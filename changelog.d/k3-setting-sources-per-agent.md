---
section: 🔒 Sécurité
---

- **Vos réglages Claude personnels ne guident plus que le coder** (K3). Votre `~/.claude` (votre `CLAUDE.md`, vos skills, vos hooks) et le `.claude/settings.local.json` du projet étaient chargés par toutes les sessions Claude, planner et QA compris. Seul le coder les charge désormais ; les autres agents ne lisent que les réglages du projet, ce qui rend la planification et la revue identiques d'une machine à l'autre. `AUTO_CLAUDE_CODER_USER_SETTINGS=false` les retire aussi au coder, `AUTO_CLAUDE_SETTING_SOURCES` impose une liste à tous les agents.
