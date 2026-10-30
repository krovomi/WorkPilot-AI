---
section: 🔒 Sécurité
---

- **Chaque release publie son SBOM et une attestation de provenance**. `workpilot-sbom.cdx.json`
  liste les paquets npm et Python de la version, et chaque fichier publié se vérifie avec
  `gh attestation verify <fichier> --repo krovomi/WorkPilot-AI`.
