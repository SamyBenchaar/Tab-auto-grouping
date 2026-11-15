# Tab Context Grouper

Extension Chrome (Manifest V3) qui regroupe automatiquement les onglets par **contexte** (« achat de voiture », « restaurants », « voyage à Rome »…) grâce à **Gemini sur Vertex AI**, appelé via une API **Cloud Run**. Aucune clé d'API n'est stockée dans l'extension : les utilisateurs se connectent avec Google et disposent d'un nombre de regroupements par IA limité par jour.

Publication sur le Chrome Web Store (fiche non répertoriée) : voir [docs/publication.md](docs/publication.md).

Exemple : 10 onglets ouverts, dont 4 recherches de voitures et 6 recherches de restaurants. Le 10ᵉ onglet déclenche le regroupement et produit deux groupes, `🚗 Voitures` et `🍽️ Restaurants`, environ 2,5 s plus tard (anti-rebond compris).

Le plan d'origine est dans [plan.md](plan.md). Les écarts par rapport à ce plan sont détaillés plus bas, avec leurs raisons.

## Démarrage rapide (5 min, sans cloud)

1. Ouvrir `chrome://extensions`, activer le **Mode développeur**, puis cliquer sur **Charger l'extension non empaquetée** et choisir le dossier [extension/](extension/). Il n'y a pas d'étape de build.
2. La page Options s'ouvre. Choisir un moteur :
   - **Heuristique locale** : fonctionne tout de suite, hors ligne, sans IA (mots-clés et domaines) ;
   - **Gemini API direct** (prototype) : coller une clé AI Studio. La clé reste dans ce profil Chrome ; à remplacer par le backend avant la démo ;
   - **Gemini via le service en ligne** (backend Cloud Run) : bouton **Se connecter avec Google** (voir [Connexion Google et limite quotidienne](#connexion-google-et-limite-quotidienne)), ou jeton propriétaire dans **Paramètres avancés**.
3. Cliquer sur **Tester la connexion**, puis ouvrir 10 onglets. Les groupes apparaissent ; la popup (icône de l'extension) permet ensuite de les annuler, de tout dégrouper ou de les renommer. Le raccourci `Alt+G` lance un regroupement manuel.

## Backend en local

```powershell
cd backend
npm install
Copy-Item .env.example .env   # puis éditer .env
npm run dev                   # http://localhost:8080 (recharge à chaud, copie le cœur partagé)
```

Deux modes, à choisir dans `.env` :

- **Vertex AI**, comme en production : lancer `gcloud auth application-default login`, puis renseigner `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=<id>` et `GOOGLE_CLOUD_LOCATION=eu` ;
- **Clé AI Studio**, pour tester vite : supprimer la ligne `GOOGLE_GENAI_USE_VERTEXAI` et définir `GEMINI_API_KEY`.

Sans identifiants, le serveur fonctionne quand même : chaque réponse vient alors de l'heuristique, avec un champ `error` qui explique pourquoi.

Dans les options de l'extension, choisir **Gemini via le service en ligne**, puis dans **Paramètres avancés** l'URL `http://localhost:8080` et, comme jeton propriétaire, la valeur de `EXTENSION_TOKEN` du `.env`. En local, les compteurs quotidiens restent en mémoire (`QUOTA_STORE=memory`).

## Déploiement sur Cloud Run

Prérequis : [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installé (ou Cloud Shell) et facturation activée. Les scripts sont en Node et fonctionnent sous PowerShell, macOS, Linux et Cloud Shell.

```powershell
cd backend
npm run setup-gcp   # projet lu dans deploy.config.json (ou --project <ID_PROJET>)
npm run deploy
```

- `setup-gcp` est rejouable sans risque (idempotent). Il active les API Vertex AI, Cloud Run, Artifact Registry, Cloud Build, Secret Manager et Firestore. Il crée :
  - le compte de service `tab-classifier-sa` (rôles `roles/aiplatform.user` et `roles/datastore.user`) ;
  - le secret `extension-token` (jeton propriétaire), répliqué en `europe-west1`. **Il l'affiche une seule fois** ;
  - la base Firestore `(default)` en `europe-west1` (offre gratuite), avec une règle TTL qui efface les compteurs quotidiens au bout de deux jours.
- `deploy` synchronise le cœur, lance les tests, puis exécute `gcloud run deploy --source`. Cloud Run tourne en `europe-west1`, Vertex AI est appelé sur la multi-région `eu`, avec 3 instances au maximum.
- Chaque déploiement remplace toutes les variables d'environnement du service. Les valeurs persistantes viennent donc de fichiers :
  - [backend/deploy.config.json](backend/deploy.config.json) : projet, limites quotidiennes, contact affiché sur la page de confidentialité ;
  - [extension/manifest.json](extension/manifest.json) : l'origine autorisée (ID de l'extension, déduit de `key`) et le client OAuth de la connexion Google (`oauth2.client_id`).

  Les options `--origin`, `--oauth-client-id`, `--daily-limit`, `--global-daily-limit` et `--contact` les remplacent ponctuellement.
- Si l'organisation interdit `--allow-unauthenticated` (Domain Restricted Sharing), il faut demander une exception : l'authentification repose sur la connexion Google et le jeton propriétaire.

## Connexion Google et limite quotidienne

- L'extension obtient un jeton d'accès Google avec `chrome.identity.getAuthToken` (portée `openid` seule : ni nom ni e-mail) et l'envoie dans l'en-tête `X-User-Token`. Les en-têtes `X-Google-…` sont supprimés par le frontal de Cloud Run, et `Authorization` est intercepté par lui.
- Le backend vérifie le jeton auprès de Google : il doit avoir été émis pour le client OAuth de l'extension. Il en déduit un identifiant pseudonyme (empreinte SHA-256 de l'identifiant du compte).
- **Limites** ([backend/deploy.config.json](backend/deploy.config.json)) : 30 regroupements IA par personne et par jour UTC, et 300 au total, comptés dans Firestore avant l'appel à Gemini. Au-delà, l'API répond 429 (`code: "daily_limit"`) et l'extension regroupe par mots-clés jusqu'à minuit UTC.
- Le jeton propriétaire (`X-Extension-Token`) n'est pas limité : réservé au propriétaire, à l'évaluation et au développement.
- `GET /me` renvoie l'utilisation du jour sans rien compter (page d'options). `GET /privacy` sert la politique de confidentialité ([backend/public/privacy.html](backend/public/privacy.html)).
- La configuration Google (écran de consentement, client OAuth de type « Extension Chrome ») et la publication sont décrites dans [docs/publication.md](docs/publication.md).

## Évaluation (objectif : au moins 90 % d'onglets bien classés, moins de 3 s)

Le fichier [test-data/scenarios.json](test-data/scenarios.json) contient 10 scénarios :

- démo voitures/restaurants ;
- voyage/travail ;
- études/shopping ;
- homonymes (Python, Java) ;
- sujet unique ;
- regroupement incrémental ;
- injection de prompt ;
- même site pour deux intentions ;
- onglets isolés ;
- titres multilingues.

```powershell
node tools/eval.mjs                                   # référence : heuristique seule (73,8 %)
cd backend; npm run eval -- --provider local --runs 3 --verbose   # Gemini via le pipeline du backend (.env)
node tools/eval.mjs --provider http --url https://<service>.run.app --token <jeton propriétaire>
```

Le script mesure :

- la précision : appariement un à un entre groupes attendus et produits ;
- le nombre de groupes ;
- la latence moyenne et le p95 ;
- la stabilité sur plusieurs exécutions (indice de Rand) ;
- la réussite d'une injection, le cas échéant.

`--min 0.9` renvoie un code d'erreur si l'objectif n'est pas atteint.

> ⚠️ Gemini n'a pas encore été évalué en conditions réelles : l'environnement de développement n'avait ni projet GCP ni clé. C'est la première chose à faire. Si la latence dépasse 3 s, essayer `GEMINI_MODEL=gemini-3.5-flash-lite`.

## Tests

```powershell
cd extension; npm test     # 80 tests : cœur, heuristique, déclenchement, réglages, service worker (faux chrome.*), connexion Google, paquet du store
cd backend; npm test       # 30 tests : API (auth, CORS, 400/413/429/503, repli), connexion Google, limites quotidiennes, Firestore, page de confidentialité, configuration, synchro du cœur
node tools/e2e-chrome.mjs  # vrai Chrome headless : regroupement auto + incrémental, popup, Annuler, options
cd extension; npm run package   # dist/tab-context-grouper-<version>.zip pour le Chrome Web Store (voir docs/publication.md)
```

Le test de bout en bout charge l'extension dans un profil temporaire, grâce à `Extensions.loadUnpacked` du protocole DevTools. Il ne touche pas à votre profil Chrome et range ses captures d'écran dans `tools/e2e-output/`.

## Architecture

```
extension/                      chargée telle quelle par Chrome (modules ES, pas de build)
  manifest.json                 MV3 : tabs, tabGroups, storage, alarms, notifications ; incognito interdit
  src/core/                     ★ cœur partagé avec le backend (source unique, sans chrome.* ni Node)
    request.js · prompt.js · schema.js · validate.js · heuristic.js · pipeline.js · geminiRest.js · thinking.js
  src/shared/                   réglages, extraction des requêtes de recherche, éligibilité, logique de seuil
  src/background/               service worker : événements, anti-rebond, exécution, cache, annulation, notifications
  src/popup/  src/options/      interface (FR, thème clair/sombre)
  tests/                        node:test + faux chrome.* (helpers/fakeChrome.js)
backend/                        Cloud Run (Express 5, @google/genai 2.31)
  src/app.js · server.js · gemini.js · security.js · config.js · logger.js
  src/core/                     COPIE générée de extension/src/core (npm run sync-core) : ne pas modifier
  scripts/                      sync-core, setup-gcp, deploy
tools/                          eval.mjs (évaluation), e2e-chrome.mjs (test de bout en bout)
test-data/scenarios.json
```

Flux d'une exécution :

1. Les événements `tabs.*` déclenchent un anti-rebond de 2,5 s.
2. Le service worker compte les nouveaux onglets non groupés de la fenêtre et les compare au seuil (10 au départ, puis 3 une fois que la fenêtre a des groupes). Un délai minimum de 30 s sépare deux exécutions, géré par `chrome.alarms`.
3. La requête est minimisée : titre, domaine, chemin d'URL et requête de recherche.
4. Elle part vers `POST /classify`, ou vers Gemini en direct, ou vers l'heuristique locale.
5. La réponse est validée.
6. L'extension appelle `chrome.tabs.group` et `chrome.tabGroups.update`, puis enregistre l'historique pour **Annuler**, met à jour le badge et affiche une notification avec un bouton « Annuler ».

Côté serveur, le traitement suit ces étapes :

1. Validation et troncature de la requête.
2. Remplacement des ID d'onglets par 1…N : les ID Chrome n'atteignent jamais le modèle.
3. Appel à Gemini avec `responseJsonSchema` et un délai maximum de 8 s.
4. Validation stricte de la réponse :
   - ID inconnus ou en double supprimés ;
   - un nouveau groupe doit contenir au moins 2 onglets ;
   - nombre de groupes plafonné à `maxGroups` ;
   - couleurs valides et distinctes ;
   - un groupe existant est retrouvé par son nom si le modèle l'a recréé.
5. En cas d'échec : un nouvel essai, puis repli sur l'heuristique.

## Choix techniques et écarts par rapport au plan

| Sujet | Plan | Implémenté | Raison |
|---|---|---|---|
| Modèle | « Gemini Flash, la plus récente » | `gemini-3.8-flash` (GA), configurable par `GEMINI_MODEL` | `gemini-2.5-flash` a été retiré de Vertex AI en octobre 2026 ; `gemini-3.6-flash` sera retiré le 19/11/2026. |
| Région | `europe-west1` | Cloud Run en `europe-west1`, **Vertex AI en multi-région `eu`** (`aiplatform.eu.rep.googleapis.com`) | Les modèles Gemini 3.x ne sont pas proposés en `europe-west1` ; la multi-région `eu` garde le traitement dans l'UE (RGPD). |
| Température | 0,1–0,2 | Valeur par défaut du modèle (`GEMINI_TEMPERATURE` pour expérimenter) | Google déconseille de baisser la température sur Gemini 3.x, et 3.6 Flash ignore même les valeurs personnalisées. La stabilité vient du schéma JSON, de la réutilisation des groupes et du cache. |
| Raisonnement (thinking) | — | `thinkingLevel: LOW` | Pour la latence : 3.8 Flash n'accepte pas `MINIMAL`. |
| Sortie structurée | `responseSchema` | `responseJsonSchema` (JSON Schema standard) | Même schéma pour Vertex AI et AI Studio. |
| Langage | TypeScript + Vite | JavaScript (modules ES et JSDoc), sans build | Option « sans build pour le MVP » prévue par le plan : on charge l'extension et c'est prêt. |
| Backend | Node ou Python | Node (Express) | Même langage que l'extension, donc cœur partagé (prompt, validation, heuristique). |
| Questions ouvertes | §13 | Seuil **par fenêtre** ; tous les onglets non épinglés sont éligibles | Propositions du plan retenues. |
| Respect des choix de l'utilisateur | — | Un onglet que l'utilisateur sort d'un groupe, ou dont le regroupement a été annulé, n'est plus regroupé automatiquement (sauf demande manuelle) | Éviter de « se battre » avec l'utilisateur. |

## Confidentialité

- **Envoyé pour chaque onglet :**
  - le titre, limité à 150 caractères ;
  - le domaine ;
  - le chemin de l'URL, **sans paramètres ni fragment**. Les identifiants longs, e-mails et UUID y sont masqués : ID Google Docs, liens de réinitialisation, etc. ;
  - la requête de recherche éventuelle.

  Le contenu des pages n'est jamais envoyé.
- **Jamais envoyé :**
  - les onglets épinglés ;
  - la navigation privée (`"incognito": "not_allowed"`) ;
  - les pages `chrome://` et `about:` ;
  - les domaines exclus, définis dans les options.
- Les titres sont traités comme des **données non fiables** : ils sont balisés et échappés dans le prompt, la sortie est validée côté serveur et le scénario d'injection fait partie de l'évaluation.
- Le serveur ne journalise jamais les titres ni les URL : seulement des compteurs, la latence et les erreurs.
- **Compte Google** : portée `openid` seule. Firestore ne contient qu'un identifiant pseudonyme, la date et un compteur par personne et par jour, effacés automatiquement (TTL) au bout de 2 à 3 jours.
- Politique de confidentialité publique (français et anglais) : `GET /privacy` sur le backend, par exemple `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.

## Limites connues et suites possibles

- Gemini reste à évaluer en conditions réelles avec `npm run eval` (voir ci-dessus), puis le prompt est à ajuster ([extension/src/core/prompt.js](extension/src/core/prompt.js)).
- La connexion Google passe par `chrome.identity.getAuthToken`, propre à Chrome : dans Edge ou Brave, utiliser l'heuristique locale ou une clé Gemini.
- La limitation de débit par minute est en mémoire, par instance, et bornée par `--max-instances` ; les limites quotidiennes, elles, sont globales (Firestore).
- L'autorisation d'hôte `https://*.run.app/*` couvre tous les services Cloud Run : on pourra la restreindre à l'URL du service une fois l'adresse définitive.
- Hors MVP : meta description (`scripting`), cache serveur (Firestore), embeddings, Gemini Nano local.
