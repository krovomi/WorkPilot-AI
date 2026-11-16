---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F2c (suivi de l'usage des comptes)** : le moniteur qui mesure l'usage de chaque provider et bascule de compte Claude avant une limite passe de 27 % à 100 % des instructions, des fonctions et des lignes (95 % des branches). Les tests décrivent une machine (profils Claude et API, réglages, trousseaux, réseau par adresse, commande `claude usage`) et font tourner le vrai moniteur dessus : Copilot, Windsurf (cache de l'IDE, clé de service, SSO), OpenAI (plan ChatGPT, clé d'API), Anthropic, cache de 15 s, attente après un 429, échec d'authentification, bascule anticipée.
- **Nom du compte affiché** : l'usage d'un compte Claude prenait le nom du premier profil API Anthropic trouvé, dès qu'il en existait un. Il porte maintenant le nom du compte mesuré.
- **Refus d'identifiants lu dans la réponse** : un refus renvoyé avec un autre code que 401 ou 403 (un 400 qui nomme le jeton) finissait en « Check failed » ; il déclenche maintenant le rafraîchissement du jeton puis, au besoin, la bascule de compte, comme un 401.
- **Bascule de compte Claude** : Windsurf ou Copilot à 100 % ne déclenche plus de changement de compte Claude.
- **Profil Copilot ou Windsurf sans clé** : il était cherché sous l'identifiant du compte Claude actif, une autre liste ; il est cherché sous l'identifiant actif des profils API.
- Le minuteur de 30 s qui borne la lecture de tous les comptes est annulé une fois la lecture finie, au lieu de rester armé à chaque rafraîchissement.
- Code jamais exécuté retiré (220 lignes) : un second contrôle du cache qui ne pouvait jamais répondre, des branches Copilot, Windsurf et OpenAI de la lecture de l'API que d'autres chemins traitent avant elle, une recherche de profil quand l'appelant le donne toujours, une lecture d'API pour des providers sans adresse d'usage.
