---
section: 🐛 Corrections
---

- **La vérification des apps Windows démarre sur une machine froide**. L'assistant UI Automation
  dit qu'il démarre avant que PowerShell ne lise son code C#, et le premier signe de vie a 120 s
  au lieu de 60 : sur une machine Windows chargée, il n'était parfois pas arrivé à temps, et la
  vérification s'arrêtait sur « the UI Automation helper did not start ».
