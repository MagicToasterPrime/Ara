# ARA — Plateforme Collaborative Académique Auto-Hébergée

**Ara** est une plateforme web collaborative tout-en-un (single-server, 100 % auto-hébergée) conçue pour une promotion d'étudiants. Elle réunit dans une interface éditoriale rigoureuse (*Swiss Editorial / Paper Utility*) :

- **Espaces de cours par UE (Cours, Discussion, Tableaux blancs, Studio Notebook)** : chapitres structurés, distinction *Cours Officiels* / *Notes Étudiantes*, votes (`▲`), épinglage officiel (`VALIDÉ PAR RESP. UE`), lecteur PDF custom intégré (`pdfjs-dist` avec recherche interne, zoom, mode texte et plein écran), canal de discussion temps réel dédié à chaque UE, et Studio Notebook façon NotebookLM (schémas téléchargeables en `.svg`, flashcards, quiz ciblés et fiches synthèses).
- **Spix IA (RAG Local contextuel & Studio)** : bouton carré flottant en bas de l'écran qui détecte automatiquement la page consultée (cours PDF ouvert, UE ou vue globale) avec indexation dans PostgreSQL + `pgvector` (`nomic-embed-text` + `gemma3:12b` via Ollama), streaming, citations cliquables (`[FICHIER.PDF · P.12]`) et génération directe de schémas `.svg`, flashcards et quiz.
- **Révisions journalières & Classement de Streak** : activation optionnelle par étudiant générant chaque jour des quiz sur des chapitres aléatoires (QCU, QCM, phrases à trou et pointage sur image de cours) avec classement de streak de la promotion.
- **Tableaux blancs collaboratifs (Tldraw)** : espace personnel par utilisateur (`Privé` ou `Public`), intégration officielle dans l'UE par le responsable d'UE, curseurs multi-utilisateurs temps réel et sauvegarde automatique en PostgreSQL toutes les 3 secondes.
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
4. Si Ollama n'est pas allumé en local, Ara reste 100 % fonctionnel : les PDF s'uploadent normalement (`isIndexed = false`) et Spix affiche un bandeau sobre *« Serveur Ollama hors-ligne (127.0.0.1:11434) »*.

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
4. Installation d'**Ollama** et téléchargement automatique de `nomic-embed-text` et `gemma3:12b`.
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
