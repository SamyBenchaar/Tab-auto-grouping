# Publier l'extension sur le Chrome Web Store (non répertoriée)

Objectif : les personnes qui ont le lien installent l'extension en un clic (« Ajouter à Chrome »), se connectent avec Google, et disposent de 30 regroupements par IA par jour. Sans connexion, l'extension regroupe par mots-clés.

| Étape | Qui | Durée |
|---|---|---|
| 1. Compte développeur Chrome Web Store | vous | 5 min, 5 $ US une fois |
| 2. Brouillon : obtenir l'ID de l'élément et sa clé publique | vous | 5 min |
| 3. Écran de consentement Google et client OAuth | vous | 10 min |
| 4. Configurer l'extension et le backend | dépôt | 5 min |
| 5. Fiche, confidentialité, visibilité « Non répertorié », soumission | vous | 20 min, puis examen de quelques jours |
| 6. Inviter des personnes | vous | — |

## 1. Compte développeur

Ouvrir le [tableau de bord du Chrome Web Store](https://chrome.google.com/webstore/devconsole), accepter le contrat et payer les frais d'inscription uniques. L'adresse de contact choisie apparaît sur la fiche de l'extension.

## 2. Brouillon : ID de l'élément et clé publique

```powershell
cd extension
npm run package -- --draft   # dist/tab-context-grouper-0.1.0-draft.zip
```

1. Tableau de bord → **Nouvel élément** → téléverser ce zip. **Ne pas le soumettre** : il sert seulement à réserver l'identifiant.
2. Noter l'**ID de l'élément** (32 lettres, visible dans l'adresse de la page de l'élément).
3. Onglet **Package** → **Afficher la clé publique** → copier la clé (le texte entre les lignes `BEGIN` et `END`, sans ces lignes).

## 3. Connexion Google

Dans [Google Auth Platform](https://console.cloud.google.com/auth/overview?project=tab-auto-grouping) (projet `tab-auto-grouping`) :

1. **Branding** : nom de l'application `Tab Context Grouper`, e-mail d'assistance, lien vers la politique de confidentialité : `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.
2. **Audience** : type **Externe**. Laisser l'état **En test** et ajouter, dans **Utilisateurs test**, l'adresse Gmail de chaque personne invitée (100 au maximum), y compris la vôtre. Seules ces personnes pourront se connecter. Pour ouvrir à tout le monde plus tard : **Publier l'application** (avec la seule portée `openid`, Google ne demande normalement pas de validation).
3. **Accès aux données** : ajouter la portée `openid`.
4. **Clients** → **Créer un client** → type **Extension Chrome** → ID de l'élément = celui de l'étape 2 → copier l'**ID client** (`….apps.googleusercontent.com`).

## 4. Configurer l'extension et le backend

1. Dans [extension/manifest.json](../extension/manifest.json), ajouter :

   ```json
   "key": "<clé publique de l'étape 2>",
   "oauth2": { "client_id": "<ID client de l'étape 3>", "scopes": ["openid"] },
   ```

   La clé donne à l'extension chargée en développement le même ID que sur le store.
2. Redéployer : `cd backend; npm run deploy`. Le script lit le manifeste : l'API n'accepte plus que cette extension (CORS) et la connexion Google est activée.
3. Dans `chrome://extensions`, recharger l'extension non empaquetée. Son ID change (c'est désormais celui du store) : les réglages repartent des valeurs par défaut. Cliquer sur **Se connecter avec Google**, puis **Tester la connexion**.
4. Construire le paquet final : `cd extension; npm run package` → `dist/tab-context-grouper-0.1.0.zip`. Le script refuse de le construire tant que le client OAuth manque, et retire `key` du manifeste (le store signe avec la même clé).

## 5. Fiche et soumission

Dans l'élément créé à l'étape 2 :

- **Package** → **Importer un nouveau paquet** → le zip final.
- **Fiche du Chrome Web Store** : textes ci-dessous, catégorie *Productivité*, langue *français*, icône `extension/icons/icon128.png`, au moins une capture d'écran de 1280 × 800 (popup et page d'options).
- **Pratiques de confidentialité** : textes ci-dessous, URL de la politique : `https://tab-classifier-11839059749.europe-west1.run.app/privacy`.
- **Distribution** : visibilité **Non répertorié**, toutes les régions.
- **Envoyer pour examen.** L'examen prend en général quelques jours ; l'élément peut être publié automatiquement après validation.

## 6. Inviter des personnes

1. Ajouter leur adresse Gmail dans **Utilisateurs test** (étape 3).
2. Leur envoyer le lien de la fiche (bouton **Copier le lien** de l'élément).
3. De leur côté : **Ajouter à Chrome** → la page d'options s'ouvre → **Se connecter avec Google**.

## Mises à jour

Augmenter `version` dans `extension/manifest.json` (par exemple `0.1.1`), lancer `npm run package`, importer le zip dans l'onglet **Package** et soumettre. Chrome met à jour les installations tout seul.

## Limites et coûts

- **30 regroupements IA par personne et par jour, 300 au total** (jour UTC). Au-delà, l'extension regroupe par mots-clés jusqu'à minuit UTC. Pour changer ces valeurs : `backend/deploy.config.json`, puis `npm run deploy` (0 = illimité).
- Le **jeton propriétaire** (Secret Manager, `extension-token`) contourne ces limites : gardez-le pour vous.
- L'alerte budgétaire du compte de facturation prévient par e-mail mais n'arrête rien ; le plafond global, lui, arrête les appels à Gemini.

---

## Textes à copier dans le tableau de bord

### Description courte (132 caractères au maximum)

> Regroupe automatiquement vos onglets par sujet (achats, voyage, travail…) grâce à l'IA Gemini. Annulation en un clic.

### Description détaillée

> Trop d'onglets ouverts ? Tab Context Grouper les range pour vous dans des groupes d'onglets Chrome nommés selon leur sujet : « 🚗 Voitures », « 🍽️ Restaurants », « ✈️ Voyage à Rome »…
>
> • Automatique : dès 10 onglets non groupés dans une fenêtre, puis à chaque nouvelle série de 3 onglets.
> • Manuel si vous préférez : bouton « Regrouper maintenant » ou raccourci Alt+G.
> • Annulation en un clic, depuis la popup ou la notification. Un onglet que vous sortez d'un groupe n'y est pas remis de force.
> • Renommez les groupes depuis la popup, choisissez la langue des noms, excluez des domaines (banque, messagerie…).
>
> Respect de la vie privée : seuls le titre, le domaine et le chemin de l'adresse des onglets concernés sont envoyés, sans paramètres ni contenu des pages. Les onglets épinglés, la navigation privée et les domaines exclus ne sont jamais envoyés. Ces données ne sont pas conservées sur le serveur.
>
> Connexion avec votre compte Google (aucun nom ni e-mail transmis) : 30 regroupements par IA par jour. Sans connexion, ou au-delà, l'extension regroupe par mots-clés, hors ligne.

### Objectif unique

> Regrouper automatiquement les onglets ouverts dans des groupes d'onglets Chrome nommés selon leur sujet.

### Justification des autorisations

| Autorisation | Justification |
|---|---|
| `tabs` | Lire le titre et l'adresse des onglets ouverts pour déterminer leur sujet, puis les déplacer dans les groupes. |
| `tabGroups` | Créer, nommer, colorer et replier les groupes d'onglets ; annuler un regroupement. |
| `storage` | Enregistrer les réglages, un cache local des classements (24 h) et l'historique permettant d'annuler. |
| `alarms` | Respecter le délai minimal entre deux regroupements automatiques, même après la mise en veille du service worker. |
| `notifications` | Indiquer qu'un regroupement a eu lieu, avec un bouton « Annuler ». |
| `identity` | Connexion avec Google (portée `openid` uniquement) pour appliquer la limite quotidienne par personne du service en ligne. |
| Autorisations d'hôte | `*.run.app` : service de classement hébergé sur Google Cloud Run. `localhost` : serveur de développement. `generativelanguage.googleapis.com` : mode facultatif où l'utilisateur fournit sa propre clé d'API Gemini. |
| Code distant | « Non » : tout le code est dans le paquet ; le service ne renvoie que des données JSON. |

### Utilisation des données

- Types de données collectées :
  - **Historique Web** : titres et adresses (sans paramètres) des onglets à regrouper ;
  - **Informations d'authentification** : jeton d'accès Google temporaire, vérifié puis oublié ;
  - **Informations permettant d'identifier personnellement l'utilisateur** : identifiant du compte Google, conservé sous forme pseudonyme avec un compteur du jour, effacé après 2 à 3 jours.

  Dans le doute, cochez aussi **Contenu des sites Web** (les titres de page) : déclarer davantage n'est pas pénalisé, déclarer moins l'est.
- Cocher les trois certifications : pas de vente à des tiers, pas d'usage sans rapport avec l'objectif unique, pas d'évaluation de solvabilité.
