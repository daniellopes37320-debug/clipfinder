# ClipFinder

Outil gratuit et local pour créer des Shorts verticaux (9:16) à partir de **tes** vidéos : il propose les meilleurs moments, cadre, sous-titre, rédige titre + description, puis tu télécharges ou publies sur ta chaîne.

## Installer depuis GitHub (Windows)
1. **Installe les 3 outils** (une seule fois). Ouvre PowerShell et tape :
   ```
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   winget install Gyan.FFmpeg
   ```
   Puis **ferme et rouvre PowerShell** (obligatoire, sinon les commandes ne sont pas reconnues).
   Vérifie : `node -v`, `git --version` et `ffmpeg -version` doivent répondre.
2. **Télécharge ClipFinder.** Place-toi dans `C:\` (pas dans `C:\Windows\System32`), puis :
   ```
   cd C:\
   git clone https://github.com/daniellopes37320-debug/clipfinder.git
   cd clipfinder
   npm install
   ```
3. **Lance** : double-clique sur `start-clipfinder.bat` dans `C:\clipfinder`, puis ouvre http://localhost:3000.
4. **Pour publier sur YouTube** (facultatif) : suis la section « Publier sur YouTube » plus bas.

Chaque personne l'installe **chez elle** : les vidéos restent sur son PC. Chacun crée son propre accès Google Cloud : les clés ne sont jamais dans le dépôt (`.env` est ignoré par Git).
Mise à jour : `cd C:\clipfinder`, puis `git pull` et `npm install`.

---

Colle un lien YouTube → le site propose les meilleurs moments → crée un Short vertical 9:16 (cadrage auto, sous-titres) à partir de **ta** vidéo → téléchargement ou publication sur ta chaîne.

## Utiliser
1. Colle le lien YouTube, choisis la durée visée, clique Analyser.
2. Envoie le fichier vidéo correspondant (ou analyse un fichier seul, avec .srt/.vtt facultatif).
3. Choisis le cadrage : visage, auto, centre, gauche, droite ou flou. Option sous-titres.
4. « Affiner avec le son » cale les extraits sur les silences.
5. Télécharge le Short, ou publie-le.

Analyse gratuite par défaut. `ANTHROPIC_API_KEY` dans `.env` = IA payante, facultative.

## Cadrage et choix des moments
- **Cadrage « visage » aéré** : si le visage est trop gros (gros plan), le site élargit la zone visible (plan moyen, fond flou en haut et en bas). Il dézoome davantage si la personne bouge vite ou s'il y a plusieurs visages. Un plan déjà moyen reste inchangé.
- **Choix des moments** : avec un fichier vidéo, le score combine le texte (accroches, mots forts) et le son (début dynamique, pics de voix, volume expressif). Le temps mort au début et à la fin est coupé. La hauteur de la voix n'est pas mesurée : les changements de ton sont estimés par les variations de volume.

## Titres et descriptions automatiques
Le site propose un titre (et 2 à 3 autres idées, cliquables) et une description complète : accroche, « Extrait de … », lien vers la vidéo complète (avec un lien YouTube), appel à s'abonner et hashtags.
- **Clip musical** (nom contenant « Clip Officiel », « Official Video », « Lyrics »…) : « Le nouveau banger de Artiste 🔥 » si le nom est de la forme « Artiste - Titre », sinon « Nouveau clip : Nom 🔥 ».
- **Autres vidéos** : le titre vient de la phrase la plus accrocheuse (si on a le texte), sinon du nom du fichier. Reconnaît aussi podcast/émission, jeu, tuto, humour, sport pour les hashtags.
- Astuce : nomme tes fichiers « Artiste - Titre (Clip Officiel).mp4 » pour de meilleurs titres. Tout reste modifiable avant de publier.

## Dépôt automatique (« À valider »)
Glisse une vidéo (+ son `.srt`/`.vtt` du même nom, facultatif) dans le dossier `inbox`. Le site crée jusqu'à 3 Shorts, qui apparaissent dans « À valider ». Tu les vérifies, puis tu les publies ou les refuses. **Rien n'est jamais publié automatiquement.**
Le dépôt utilise le cadrage « suit l'action ». Dans « À valider », le bouton **Recadrer sur le visage** refait le Short en suivant le visage (la vidéo d'origine doit rester dans `inbox`).
Pour analyser un fichier avec ses sous-titres : bouton « Ajouter des sous-titres » avant d'envoyer la vidéo.

Dans « À valider », la liste « Vidéos dans inbox » permet de supprimer une vidéo d'origine (et ses sous-titres) depuis le site, après confirmation. Les Shorts déjà créés sont gardés.

## Logo de chaîne (facultatif)
Place un fichier `logo.png` (fond transparent, de préférence carré) à côté de `server.js` (`C:\clipfinder`) : il est ajouté en haut à droite de tous les nouveaux Shorts. Supprime-le pour ne plus en mettre. Relance le site après l'avoir ajouté.

## Publier sur YouTube (facultatif, gratuit)
1. Va sur [console.cloud.google.com](https://console.cloud.google.com) et crée un **nouveau projet** (vérifie qu'il est bien sélectionné en haut de la page).
2. Menu ☰ → « API et services » → **Bibliothèque** → cherche **YouTube Data API v3** → **Activer**.
3. **Écran de consentement OAuth** (ou « Google Auth Platform ») : type **Externe**, renseigne un nom d'appli et ton e-mail.
4. Dans la section **Audience** → **Utilisateurs test** → **Add users** : ajoute **ton adresse Gmail** (celle de ta chaîne YouTube) et enregistre. *Sans cette étape, Google affiche « Accès bloqué : erreur 403 access_denied ».*
5. **Identifiants** → Créer des identifiants → **ID client OAuth** → type **Application Web**. Dans « URI de redirection autorisés », ajoute exactement : `http://localhost:3000/oauth/callback`.
6. Copie l'**ID client** et le **code secret**. Dans `C:\clipfinder`, copie `.env.example`, renomme la copie `.env`, ouvre-la avec le Bloc-notes et remplis `GOOGLE_CLIENT_ID=` et `GOOGLE_CLIENT_SECRET=` (sans espaces ni guillemets). Enregistre, ferme ClipFinder et relance-le.
7. Dans le site, clique sur **Connecter ma chaîne YouTube** (onglet « À valider »). Si Google affiche « Google n'a pas validé cette appli », clique sur **Paramètres avancés** → **Accéder à … (non sécurisé)** : c'est ton propre projet.
8. Avant de publier, coche « J'ai l'autorisation ».

Notes : publication en **privé** par défaut. À ma connaissance, un projet Google non vérifié garde les vidéos privées, et la connexion en mode test peut expirer après ~7 jours (reconnecte-toi). Quota limité par jour.

## Automatisation légère
`auto-clipfinder.bat -Depot "C:\dossier" -Ouvrir` lance le site en arrière-plan et copie vers `inbox` les nouvelles vidéos d'un dossier que tu possèdes (ex. dossier partagé avec un partenaire).

## Droits
Ne publie que tes vidéos ou celles de partenaires qui t'ont donné leur accord.

## Réglages (`.env`, tous facultatifs)
| Variable | Rôle |
|---|---|
| `PORT` | Port du site (3000 par défaut ; si tu changes, mets aussi l'URI de redirection Google à jour) |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | Analyse par IA ; vide = analyse gratuite. Si l'IA ne répond pas en 60 s, l'analyse simple prend le relais |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Publication YouTube |
| `MAX_UPLOAD_GB` | Taille maximale d'une vidéo envoyée (4 par défaut) |
| `KEEP_DAYS` | Supprime les Shorts de plus de N jours (0 = jamais ; les Shorts « à valider » sont gardés) |

## Dépannage
- **« ffmpeg est introuvable »** : `winget install Gyan.FFmpeg`, puis ferme et rouvre PowerShell.
- **`redirect_uri_mismatch`** (Google) : l'URI doit être exactement `http://localhost:3000/oauth/callback` dans Google Cloud.
- **« Accès bloqué : erreur 403 access_denied »** : ton adresse Gmail n'est pas dans les utilisateurs test (étape 4 ci-dessus).
- **La connexion YouTube expire au bout de 7 jours** : écran de consentement en mode « Test » ; reconnecte-toi ou passe-le en production.
- **Les vidéos publiées restent privées** : normal pour un projet Google non validé ; change la visibilité dans YouTube Studio.
- **Pas de visage détecté** : le modèle de détection se charge depuis Internet ; sans connexion le cadrage « suit l'action » est utilisé.
- **Un fichier de l'inbox est en erreur** : clique sur « Réessayer les fichiers en erreur » dans l'onglet À valider.
- **Port déjà utilisé** : ferme l'autre fenêtre ClipFinder ou change `PORT`.

## Développement
`npm run check` (syntaxe) et `npm test` (tests, Node ≥ 18). Une vérification automatique tourne sur GitHub à chaque envoi.

## Sécurité
Le serveur n'écoute que sur ton PC (127.0.0.1) et refuse les requêtes venant d'autres sites. L'envoi sur YouTube exige la case « J'ai l'autorisation ». Ne partage jamais `.env` ni `youtube-token.json`.
