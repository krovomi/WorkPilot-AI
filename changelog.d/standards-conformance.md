---
section: 📚 Documentation
---

- **Conformité aux standards ouverts.** Une page dit quelles versions de MCP, ACP, AGENTS.md et
  des conventions OpenTelemetry GenAI WorkPilot parle, et, pour chaque provider, comment les
  outils MCP et les instructions du projet l'atteignent. `capabilities/providers.yaml` gagne un
  champ `standards`, vérifié contre le code par un test : un provider dit « relié à MCP » tourne
  sur un client qui a le pont, un provider dit « reçoit AGENTS.md » est construit avec le prompt
  qui le porte. Ce qui n'est pas vérifié est marqué `unverified`, jamais compté comme un support.
