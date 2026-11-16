# ARA — Plateforme Collaborative Académique Auto-Hébergée

**Ara** est une plateforme web collaborative tout-en-un (single-server, 100 % auto-hébergée) conçue pour une promotion d'étudiants. Elle réunit dans une interface éditoriale rigoureuse (*Swiss Editorial / Paper Utility*) :

- **Espaces de cours par UE** : chapitres structurés, distinction *Cours Officiels* / *Notes Étudiantes*, votes (`▲`), épinglage officiel (`VALIDÉ PAR RESP. UE`), et lecteur PDF natif intégré.
- **Hyacinthe IA (RAG Local)** : indexation automatique des PDF dans PostgreSQL + `pgvector` (`nomic-embed-text` + `qwen2.5:7b` via Ollama) avec réponses en streaming et citations cliquables (`[FICHIER.PDF · P.12]`).
- **Messagerie temps réel (Socket.io)** : canaux `#général`, canaux automatiques `#ue-...` et groupes d'étude avec partage direct de cours et tableaux blancs.
- **Tableaux blancs collaboratifs (Tldraw)** : curseurs multi-utilisateurs en temps réel et sauvegarde automatique en PostgreSQL toutes les 3 secondes.
- **Gouvernance hiérarchique** : bootstrap automatique du premier compte inscrit en **Responsable d'Année (`YEAR_ADMIN`)**, nomination des **Responsables d'UE (`UE_MANAGER`)**, et monitoring système.

---

## 1. Test rapide sur PC (sans configuration manuelle de BDD)

```bash
npm install
npm run dev:full
```

Le script `npm run dev:full` (`scripts/dev-full.mjs`) :
1. Initialise `.env` et `./storage/uploads/`.
2. Démarre automatiquement la base PostgreSQL 16 + `pgvector` via Docker Compose si disponible, **ou lance un moteur PostgreSQL 16 + `pgvector` embarqué localement (PGlite)** dans `./storage/pgdata` si Docker n'est pas installé sur votre poste.
3. Applique le schéma Prisma et démarre le serveur unifié (`Next.js` + `Socket.io`) sur `http://localhost:3000`.
4. Si Ollama n'est pas allumé en local, Ara reste 100 % fonctionnel : les PDF s'uploadent normalement (`isIndexed = false`) et Hyacinthe affiche un bandeau sobre *« Serveur Ollama hors-ligne (127.0.0.1:11434) »*.

---

## 2. Déploiement Production Linux (Ubuntu / Debian) en une commande

Sur votre serveur dédié Linux, exécutez :

```bash
sudo bash scripts/install.sh
```

Le script `scripts/install.sh` automatise de façon idempotente :
1. Installation des prérequis (`curl`, `git`, `openssl`, `Node.js 20 LTS`, `Docker` & `Docker Compose`).
2. Génération d'un `.env` sécurisé (`AUTH_SECRET` et `POSTGRES_PASSWORD` générés via `openssl rand -hex 32`).
3. Démarrage du conteneur PostgreSQL 16 + `pgvector` (`docker-compose.yml`).
4. Installation d'**Ollama** et téléchargement automatique de `nomic-embed-text` et `qwen2.5:7b`.
5. Installation NPM (`npm ci`), migrations Prisma (`npx prisma migrate deploy`) et compilation (`npm run build`).
6. Création et activation du service **systemd** `/etc/systemd/system/ara.service` sur le port `3000`.

### Suivi des logs en production

```bash
journalctl -u ara -f
```

---

## 3. Premier démarrage & Gouvernance

1. Ouvrez `http://localhost:3000/register`.
2. Le **tout premier utilisateur inscrit** reçoit automatiquement le rôle **`YEAR_ADMIN`** (*Responsable d'Année*).
3. Accédez à **Gouvernance** (`/admin`) pour créer vos UE, nommer vos `UE_MANAGER`, surveiller l'espace disque `./storage/uploads/` et lancer une ré-indexation RAG complète.
