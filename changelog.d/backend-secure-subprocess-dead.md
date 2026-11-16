---
section: 🧹 Maintenance
---

- **Code mort retiré** : `security/secure_subprocess.py` (`run_secure`). Son seul appelant, la détection de Copilot dans les logs, passe désormais par `core.gh_executable` ; plus rien ne l'importait.
