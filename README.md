# HerobrineTroll

Bot Minecraft Java Edition 1.21.4 utilisant Mineflayer, avec un serveur HTTP de statut pour Render et des apparitions par téléportation.

## Comportement

Quand un joueur reste immobile suffisamment longtemps et se trouve à proximité, Herobrine :

- mémorise sa position actuelle ;
- se téléporte à environ 3 blocs derrière le joueur ;
- attend jusqu'à 5 secondes ;
- revient immédiatement à sa position précédente si le joueur s'approche ;
- sinon, revient à sa position précédente à la fin des 5 secondes.

Le bot ne frappe pas les joueurs et ne casse ni ne pose de blocs. Les téléportations utilisent la commande serveur `/tp`, le compte Herobrine doit donc avoir la permission de l'exécuter.

## Configuration

Variables d'environnement :

- `MC_HOST` : adresse du serveur Minecraft
- `MC_PORT` : port Minecraft (par défaut : `25565`)
- `MC_VERSION` : version Minecraft (par défaut : `1.21.4`)
- `PORT` : port HTTP fourni automatiquement par Render
- `TROLL_ENABLED` : active le comportement (par défaut : `true`)
- `IDLE_SECONDS` : durée d'immobilité requise en secondes (par défaut : `12`)
- `MAX_DISTANCE` : distance maximale entre Herobrine et le joueur (par défaut : `18`)
- `APPEAR_DISTANCE` : distance d'apparition derrière le joueur en blocs (par défaut : `3`)
- `APPEAR_SECONDS` : durée maximale de l'apparition en secondes (par défaut : `5`)

Le bot utilise le mode `offline`. Le serveur Minecraft doit donc accepter les connexions offline. Un pseudo offline n'est pas authentifié par Microsoft : ne donne pas OP à ce compte sur un serveur exposé à des joueurs non fiables.

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
