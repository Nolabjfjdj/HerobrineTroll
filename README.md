# HerobrineTroll

Bot Minecraft Java Edition 1.21.4 utilisant Mineflayer, avec un serveur HTTP de statut pour Render.

## Configuration

Variables d'environnement :

- `MC_HOST` : adresse du serveur Minecraft
- `MC_PORT` : port Minecraft (par défaut : `25565`)
- `MC_VERSION` : version Minecraft (par défaut : `1.21.4`)
- `PORT` : port HTTP fourni automatiquement par Render

Le bot utilise le mode `offline`. Le serveur Minecraft doit donc accepter les connexions offline.

## Lancement local

```bash
npm install
MC_HOST=adresse-du-serveur MC_PORT=25565 npm start
```

## Routes HTTP

- `/` : page d'accueil
- `/health` : état du service HTTP
- `/status` : état de la connexion Minecraft

## Render

Le fichier `render.yaml` contient une configuration Blueprint. Il est également possible de créer un Web Service manuellement avec :

- Build command : `npm install`
- Start command : `npm start`
- Health check path : `/health`

Définir `MC_HOST` avec l'adresse du serveur Minecraft.

## Sécurité

En mode offline, un pseudo n'est pas authentifié par Microsoft. Ne donne pas de privilèges OP à ce compte sur un serveur exposé à des joueurs non fiables.
