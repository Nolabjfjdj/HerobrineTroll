# HerobrineTroll

Bot Minecraft Java Edition 1.21.4 utilisant Mineflayer, avec un serveur HTTP de statut, des logs détaillés et des apparitions par téléportation.

## Comportement

Quand un joueur reste immobile suffisamment longtemps et se trouve à proximité, Herobrine :

- repère la direction dans laquelle le joueur regarde ;
- cherche un emplacement visible sur un bloc solide, avec deux blocs libres au-dessus ;
- exclut l'eau, la lave et plusieurs blocs dangereux ;
- mémorise sa position actuelle puis se téléporte dans le champ de vision du joueur, à une distance aléatoire ;
- disparaît immédiatement si le joueur le regarde ou s'approche ;
- sinon, revient à sa position précédente après 5 secondes.

Les téléportations utilisent la commande `/minecraft:tp`. Le compte Herobrine doit avoir la permission de l'exécuter. Les logs indiquent la commande envoyée, la destination, les messages du serveur et si la téléportation a été confirmée par la position reçue.

## Configuration

Variables d'environnement :

- `MC_HOST` : adresse du serveur Minecraft
- `MC_PORT` : port Minecraft (par défaut : `25565`)
- `MC_VERSION` : version Minecraft (par défaut : `1.21.4`)
- `PORT` : port HTTP fourni automatiquement par Render
- `TROLL_ENABLED` : active le comportement (par défaut : `true`)
- `IDLE_SECONDS` : durée d'immobilité requise en secondes (par défaut : `12`)
- `MAX_DISTANCE` : distance maximale entre Herobrine et le joueur pour choisir une cible (par défaut : `18`)
- `MIN_APPEAR_DISTANCE` : distance minimale devant le joueur (par défaut : `6`)
- `MAX_APPEAR_DISTANCE` : distance maximale devant le joueur (par défaut : `20`)
- `APPEAR_SECONDS` : durée maximale de l'apparition en secondes (par défaut : `5`)
- `LOOK_DOT_THRESHOLD` : sensibilité de détection du regard (par défaut : `0.93`)

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

Le mode offline n'authentifie pas les pseudos avec Microsoft. Un compte offline avec OP peut être usurpé par quelqu'un qui rejoint avec le même pseudo sur un serveur offline. Utiliser ce bot OP uniquement sur un serveur privé et de confiance.
