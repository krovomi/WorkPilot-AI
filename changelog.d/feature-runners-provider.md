---
section: 🐛 Corrections
---

- **Douze vues lancent leur agent avec le fournisseur choisi.** Migration de code, Context Mesh, Code Playground, générateur de pipeline, Learning Loop, Live Companion, Auto-Refactor, Git en langage naturel, Design to Code, commande vocale, profileur de performances et visualiseur d'architecture préparent leur runner comme les autres vues : le fournisseur des réglages (ou de la page) et sa clé, la connexion Claude seulement quand elle sert, la sortie non tamponnée en UTF-8. Elles partaient jusqu'ici sur Claude sous un nom de jeton que le backend ne lit pas. La détection de projet de l'émulateur et des appareils mobiles ne reçoit plus d'identifiants.
