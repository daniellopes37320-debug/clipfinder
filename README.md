# ClipFinder

Outil gratuit et local pour créer des Shorts verticaux (9:16) à partir de **tes** vidéos : il propose les meilleurs moments, cadre, sous-titre, rédige titre + description, puis tu télécharges ou publies sur ta chaîne.

## Installer depuis GitHub
1. Installe [Node.js](https://nodejs.org) (LTS), [Git](https://git-scm.com) et ffmpeg (`winget install Gyan.FFmpeg`).
2. Dans PowerShell :
   ```
   git clone https://github.com/<compte>/clipfinder.git
   cd clipfinder
   npm install
   ```
3. Double-clique sur `start-clipfinder.bat` (ou `npm start`), puis ouvre http://localhost:3000.

Chaque personne l'installe **chez elle** : les vidéos restent sur son PC. Pour publier sur YouTube, chacun crée son propre accès Google Cloud (étapes plus bas) : les clés ne sont jamais dans le dépôt (`.env` est ignoré par Git).
Mise à jour : `git pull` puis `npm install`.

---

Colle un lien YouTube → le site propose les meilleurs moments → crée un Short vertical 9:16 (cadrage auto, sous-titres) à partir de **ta** vidéo → téléchargement ou publication sur ta chaîne.

## Démarrer (Windows)
1. Installe [Node.js](https://nodejs.org) (LTS) et ffmpeg : `winget install Gyan.FFmpeg`.
2. Double-clique `start-clipfinder.bat` (installe tout et ouvre http://localhost:3000).

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
1. [console.cloud.google.com](https://console.cloud.google.com) → nouveau projet.
2. « API et services » → Bibliothèque → active **YouTube Data API v3**.
3. Écran de consentement OAuth → Externe → ajoute ton e-mail en utilisateur test.
4. Identifiants → Créer → ID client OAuth → **Application Web**.
5. URI de redirection autorisée : `http://localhost:3000/oauth/callback` (exacte).
6. Copie ID client et secret dans `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), relance.
7. Dans le site : « Connecter YouTube », puis coche « J'ai l'autorisation » avant de publier.

Notes : publication en **privé** par défaut. À ma connaissance, un projet Google non vérifié garde les vidéos privées, et la connexion en mode test peut expirer après ~7 jours (reconnecte-toi). Quota limité par jour.

## Automatisation légère
`auto-clipfinder.bat -Depot "C:\dossier" -Ouvrir` lance le site en arrière-plan et copie vers `inbox` les nouvelles vidéos d'un dossier que tu possèdes (ex. dossier partagé avec un partenaire).

## Droits
Ne publie que tes vidéos ou celles de partenaires qui t'ont donné leur accord.

## Sécurité
Le serveur n'écoute que sur ton PC (127.0.0.1). Ne partage jamais `.env` ni `youtube-token.json`.
