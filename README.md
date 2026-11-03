# HerobrineTroll

Bot Minecraft Java Edition 1.21.4 utilisant Mineflayer, avec un serveur HTTP de statut pour Render et un comportement de harcèlement visuel non agressif.

## Comportement

Quand un joueur reste immobile suffisamment longtemps et se trouve à proximité, Herobrine peut :

- se tourner vers lui ;
- avancer brièvement dans sa direction ;
- rester à le regarder ;
- reculer puis attendre avant de recommencer.

Le bot ne frappe pas les joueurs, ne casse ni ne pose de blocs et n'utilise aucune commande administrateur. Il ne peut pas se téléporter ni devenir invisible sans fonctionnalité serveur dédiée ou permissions adaptées. Son déplacement est direct et ne dispose pas de pathfinding.

## Configuration

Variables d'environnement :

- `MC_HOST` : adresse du serveur Minecraft
- `MC_PORT` : port Minecraft (par défaut : `25565`)
- `MC_VERSION` : version Minecraft (par défaut : `1.21.4`)
- `PORT` : port HTTP fourni automatiquement par Render
- `TROLL_ENABLED` : active le comportement (par défaut : `true`)
- `IDLE_SECONDS` : durée d'immobilité requise en secondes (par défaut : `12`)
- `MAX_DISTANCE` : distance maximale de détection en blocs (par défaut : `18`)

Le bot utilise le mode `offline`. Le serveur Minecraft doit donc accepter les connexions offline.

## Lancement local

```bash
npm install
MC_HOST=adresse-du-serveur MC_PORT=25565 npm start
```

## Routes HTTP

- `/` : page d'accueil
- `/health` : état du service HTTP
- `/status` : état de la connexion Minecraft et du comportement actuel

## Render

Le fichier `render.yaml` contient une configuration Blueprint. Il est également possible de créer un Web Service manuellement avec :

- Build command : `npm install`
- Start command : `npm start`
- Health check path : `/health`

Définir `MC_HOST` avec l'adresse du serveur Minecraft.

## Sécurité

En mode offline, un pseudo n'est pas authentifié par Microsoft. Ne donne pas de privilèges OP à ce compte sur un serveur exposé à des joueurs non fiables.
