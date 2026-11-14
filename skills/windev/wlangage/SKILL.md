---
name: wlangage
description: Écrire, relire et tester du WLangage, le langage de WinDev, WebDev et WinDev Mobile (PC SOFT). À utiliser pour toute tâche qui lit ou modifie le code d'une fenêtre, d'une classe, d'une collection de procédures, d'un état ou d'une page : syntaxe, accès HFSQL (fonctions H), gestion des erreurs, POO, tests en WLangage et pièges courants.
paths: "**/*.wdp,**/*.wdw,**/*.wdc,**/*.wdg,**/*.wde,**/*.wdt,**/*.wwh"
metadata:
  workpilot:
    pack: windev
---

# WLangage

Le WLangage est le langage de l'atelier PC SOFT. Ses mots-clés existent en français et en anglais
(`SI` / `IF`, `FIN` / `END`) ; le projet impose l'une ou l'autre forme par l'usage, et un fichier
garde la forme qu'il a déjà. Il n'est pas sensible à la casse, et les fonctions s'écrivent avec
ou sans accents (`HTrouve`, `HTrouvé`) : le fichier touché donne la forme à garder.

Le code ne se lit hors de l'éditeur que si le projet est sauvegardé au **format texte** :
voir le skill `windev-text-format` pour l'endroit exact où il vit dans un fichier et ce qui ne
doit jamais être touché autour.

## Syntaxe qui compte

```wlangage
// Déclarations : le type suit « est un » / « est une »
nTotal est un entier = 0
sNom est une chaîne
tabClients est un tableau de STClient
dDébut est une Date = DateDuJour()

// Procédure : paramètres typés, valeur de retour après « : »
PROCEDURE CalculeRemise(nMontant est un monétaire, sCode est une chaîne) : monétaire
SI nMontant <= 0 ALORS RENVOYER 0          // SI sur une ligne : pas de FIN
SI sCode = "VIP" ALORS
	RENVOYER nMontant * 0.1
SINON SI sCode [= "PRO" ALORS             // [= : « commence par »
	RENVOYER nMontant * 0.05
SINON
	RENVOYER 0
FIN

// Boucles
POUR i = 1 _À_ tabClients..Occurrence
FIN
POUR TOUT stClient DE tabClients
FIN
TANTQUE nTotal < 100
	nTotal++
FIN
BOUCLE
	SI Condition() ALORS SORTIR
FIN

SELON sStatut
	CAS "OK" : Traite()
	CAS "KO", "ERR" : Signale()
	AUTRE CAS : Ignore()
FIN

// Chaînes : + concatène, [% %] interpole, [[ ]] extrait
sMessage = "Client [%sNom%] : " + nTotal
sDébut = sNom[[1 À 3]]
```

- Un bloc `SI … ALORS` sur plusieurs lignes, `POUR`, `TANTQUE`, `BOUCLE`, `SELON` et
  `QUAND EXCEPTION DANS … FAIRE` se ferment par `FIN`. Aucun compilateur n'est disponible hors de
  l'éditeur : l'équilibre des `FIN` se vérifie à la relecture.
- Les propriétés s'écrivent avec `..` (`SAI_Nom..Visible = Faux`, `MaFenêtre..Plan = 2`) ;
  `MoiMême` désigne le champ courant, `MaFenêtre` la fenêtre, `MonEtat` l'état.
- Les noms suivent le préfixage de la charte du projet (`FEN_`, `BTN_`, `SAI_`, `TABLE_`, `COL_`,
  `REQ_` ; variables `n`, `s`, `b`, `tab`, `st`, `cl`, et `g` pour une globale). Un code nouveau
  reprend la charte du fichier qu'il touche.

## Données HFSQL (fonctions H)

```wlangage
HLitRecherchePremier(Client, NomClient, sNom)
SI HTrouve(Client) ALORS
	Client.Remise = CalculeRemise(Client.CA, Client.Code)
	SI PAS HModifie(Client) ALORS
		Erreur(HErreurInfo())
	FIN
FIN

POUR TOUT Commande AVEC IDClient = Client.IDClient
	nTotal += Commande.Montant
FIN
```

- Toute lecture par clé est suivie d'un test `HTrouve` ; toute écriture (`HAjoute`, `HModifie`,
  `HSupprime`) est suivie d'un test de son résultat ou de `HErreur()`.
- **Pas de SQL concaténé** avec une saisie dans `HExécuteRequêteSQL` : c'est une injection SQL.
  Une requête de l'éditeur reçoit ses paramètres (`REQ_Clients.ParamVille = sVille` puis
  `HExécuteRequête(REQ_Clients)`). Les requêtes `.wdr` sont binaires : une requête nouvelle se
  crée dans l'éditeur, le plan donne son SQL à saisir.
- L'analyse (`.wda`, fichiers, rubriques, index) est binaire : une rubrique nouvelle se crée dans
  l'éditeur d'analyses, jamais dans le code.

## Erreurs

```wlangage
QUAND EXCEPTION DANS
	Désérialise(stCommande, sJSON, psdJSON)
FAIRE
	Trace(ExceptionInfo())
	RENVOYER Faux
FIN
```

Une erreur non fatale d'une fonction se lit par `ErreurInfo()` ; une fonction H par `HErreur()`
et `HErreurInfo()`. Un traitement d'exception qui avale l'erreur sans la tracer cache le défaut.

## Classes

```wlangage
CClient est une Classe
	PUBLIC
		m_sNom est une chaîne
	PRIVÉ
		m_nRemise est un entier
FIN

PROCEDURE Constructeur(sNom est une chaîne)
:m_sNom = sNom

PROCEDURE Remise() : entier
RENVOYER :m_nRemise
```

Le `:` désigne un membre de l'objet courant ; l'héritage s'écrit `CClientPro est une Classe`
suivi de `hérite de CClient`.

## Tests en WLangage

Les scénarios de test automatique (`.wxt`) sont binaires et ne s'écrivent que dans l'éditeur.
Un test se rédige donc en **procédure WLangage**, dans une collection de procédures de test qui
existe déjà dans le projet, et s'exécute depuis l'éditeur :

```wlangage
PROCEDURE Test_CalculeRemise()
dbgVérifieEgalité(CalculeRemise(1000, "VIP"), 100, "remise VIP de 10 %")
dbgVérifieEgalité(CalculeRemise(0, "VIP"), 0, "montant nul")
dbgVérifieVrai(CalculeRemise(1000, "PRO") > 0)
dbgVérifieFaux(CalculeRemise(-5, "PRO") > 0)
```

Le rapport d'une tâche dit que ces tests sont **à lancer dans l'éditeur** : rien ne les exécute
hors de WinDev.

## Pièges courants

- `=` compare **et** affecte selon le contexte : une condition se relit pour s'assurer qu'elle
  ne s'écrit pas comme une affectation.
- Les tableaux commencent à 1 ; `..Occurrence` donne leur taille.
- Une chaîne vide se teste par `= ""` ; `Null` ne s'applique qu'aux rubriques et variants.
- `Ouvre(FEN_X)` ouvre une fenêtre modale et attend sa fermeture ; `OuvreFille` ne l'attend pas.
- Un secret (mot de passe, clé d'API) ne s'écrit jamais en dur dans le code : il vient de la
  configuration chiffrée du projet ou d'un coffre.
