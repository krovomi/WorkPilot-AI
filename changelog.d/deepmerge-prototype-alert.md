---
section: 🔒 Sécurité
---

- **Application mobile : deepmerge corrigé contre l'empoisonnement de prototype** (GHSA-gcqx-w48m-w2h4, CVE-2026-93753). Aucune version corrigée n'existe en amont : Jest, seul utilisateur de deepmerge, reçoit une copie de la 4.3.1 qui ignore la clé `__proto__` et écrit chaque propriété comme propriété propre ; elle disparaîtra à la première version corrigée.
