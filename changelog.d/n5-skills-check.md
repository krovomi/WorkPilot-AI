---
section: 🧪 Filets de test
---

- **Le contrôle des skills générés peut de nouveau échouer** (F125). La CI reconstruisait les
  skills juste avant de vérifier qu'elles étaient à jour ; les skills lues par les agents avaient
  pris du retard sur leurs sources depuis la dernière synchronisation. Elles sont régénérées, et
  la synchronisation hebdomadaire committe désormais ce qu'elle reconstruit.
