"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Leaf,
  Lock,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";

interface OnboardingModalProps {
  isOpen: boolean;
  userName?: string | null;
  classLevel?: string | null;
  onComplete: () => void;
  onClose: () => void;
}

interface OnboardingStep {
  code: string;
  accent: string;
  kicker: string;
  title: string;
  subtitle: string;
}

const STEPS: OnboardingStep[] = [
  {
    code: "01",
    accent: "#3D6B99",
    kicker: "NOTEBOOKLM CUSTOM · ONIRIS VÉTÉRINAIRE",
    title: "Bienvenue sur ARA, votre espace d'étude Oniris",
    subtitle:
      "Conçu sur-mesure pour les promotions vétérinaires (PACENV, VET2 à VET6), ARA centralise vos cours et génère vos révisions à la source.",
  },
  {
    code: "02",
    accent: "#1F7A8C",
    kicker: "SOUVERAINETÉ · CIRCUIT FERMÉ",
    title: "Aucune donnée ne sort de ce serveur",
    subtitle:
      "Contrairement aux services cloud grand public, toute l'intelligence artificielle et la recherche tournent localement sur l'infrastructure ARA.",
  },
  {
    code: "03",
    accent: "#3B7A57",
    kicker: "SOBRIÉTÉ NUMÉRIQUE · 00H00–07H00",
    title: "Hébergement écologique & mutualisation promo",
    subtitle:
      "Le serveur est hébergé de manière écologique et conçu pour éviter tout calcul redondant grâce au partage communautaire et au traitement nocturne.",
  },
  {
    code: "04",
    accent: "#D99B26",
    kicker: "PRISE EN MAIN · 3 RÉFLEXES",
    title: "Prêt à maîtriser vos UE",
    subtitle:
      "En quelques clics : retrouvez vos PDF classés par chapitres, révisez avec le Studio IA et testez-vous chaque jour.",
  },
];

export function OnboardingModal({
  isOpen,
  userName,
  classLevel,
  onComplete,
  onClose,
}: OnboardingModalProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setStepIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div
        className="ara-animate-in flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden border border-ink bg-card shadow-none"
        style={{ borderTop: `3px solid ${step.accent}` }}
      >
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-paper px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center border border-ink bg-ink font-mono text-[10px] font-bold text-card">
              ARA
            </div>
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
                [ GUIDE PREMIÈRE CONNEXION · ONIRIS ]
              </p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                {userName ? `${userName}` : "ÉTUDIANT"}
                {classLevel ? ` · PROMO ${classLevel}` : ""} · ÉTAPE {step.code}
                /{STEPS.length.toString().padStart(2, "0")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-border bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-stone hover:border-ink hover:text-ink"
            >
              PASSER LE GUIDE
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer l'onboarding"
              className="inline-flex h-7 w-7 items-center justify-center border border-border bg-card text-stone hover:border-ink hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Stepper Tabs */}
        <div className="grid grid-cols-4 border-b border-border bg-paper/60">
          {STEPS.map((s, idx) => {
            const active = idx === stepIndex;
            const visited = idx < stepIndex;
            return (
              <button
                key={s.code}
                type="button"
                onClick={() => setStepIndex(idx)}
                className={`flex items-center justify-center gap-1.5 border-r border-border px-2 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors last:border-r-0 ${
                  active
                    ? "bg-card font-bold text-ink"
                    : visited
                    ? "bg-paper text-ink hover:bg-card/60"
                    : "text-stone hover:text-ink"
                }`}
                style={
                  active
                    ? { borderBottom: `2px solid ${s.accent}` }
                    : undefined
                }
              >
                <span>{s.code}</span>
                <span className="hidden sm:inline truncate">
                  {idx === 0
                    ? "NOTEBOOKLM"
                    : idx === 1
                    ? "CONFIDENTIALITÉ"
                    : idx === 2
                    ? "ÉCOLOGIE"
                    : "DÉMARRER"}
                </span>
              </button>
            );
          })}
        </div>

        {/* Step Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
              {step.kicker}
            </p>
            <h2
              id="onboarding-title"
              className="text-lg font-bold tracking-tight text-ink sm:text-xl"
            >
              {step.title}
            </h2>
            <p className="text-sm leading-relaxed text-stone">
              {step.subtitle}
            </p>
          </div>

          {stepIndex === 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="border border-border bg-paper p-3.5">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                  <BookOpen className="h-3.5 w-3.5 text-slate" />
                  <span>ARBORESCENCE PAR UE</span>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  Vos cours sont organisés comme à l&apos;école :{" "}
                  <span className="font-mono text-ink">
                    UE ▸ Thèmes ▸ Chapitres ▸ Fichiers PDF
                  </span>
                  , filtrés par année d&apos;étude et calendrier d&apos;examens.
                </p>
              </div>

              <div className="border border-border bg-paper p-3.5">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                  <Sparkles className="h-3.5 w-3.5 text-amber" />
                  <span>STUDIO IA (95% PUBLIC / 5% PRIVÉ)</span>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  Générez des <strong>Quiz complets (30 questions QCU/QCM/QROC)</strong>,{" "}
                  <strong>60 Flashcards</strong> et des <strong>Fiches en 4 sections</strong>{" "}
                  couvrant 95% d&apos;un cours, ou des sessions privées ciblées sur vos lacunes.
                </p>
              </div>

              <div className="border border-border bg-paper p-3.5">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                  <Search className="h-3.5 w-3.5 text-forest" />
                  <span>ASSISTANT SPIX SOURCÉ</span>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  Interrogez n&apos;importe quel polycopié : Spix répond uniquement à partir de
                  vos documents Oniris avec citations exactes des pages.
                </p>
              </div>

              <div className="border border-border bg-paper p-3.5">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                  <CheckCircle2 className="h-3.5 w-3.5 text-carmine" />
                  <span>QUIZ JOURNALIER &amp; TABLEAUX BLANCS</span>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  Entretenez votre streak avec un tirage quotidien aléatoire IA sur une UE et
                  schématisez en direct avec votre promo sur les tableaux blancs collaboratifs.
                </p>
              </div>
            </div>
          )}

          {stepIndex === 1 && (
            <div className="space-y-3">
              <div
                className="border border-border bg-pinned p-4"
                style={{ borderLeft: "3px solid #1F7A8C" }}
              >
                <div className="mb-1 flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-ink">
                  <Lock className="h-4 w-4 text-ink" />
                  <span>ZÉRO FUITE VERS DES CLOUDS EXTERNES</span>
                </div>
                <p className="text-xs leading-relaxed text-ink">
                  Aucun PDF de professeur, aucune fiche étudiante et aucune conversation
                  n&apos;est transmise à des API tierces (OpenAI, Google Gemini, Anthropic, etc.).{" "}
                  <strong>100% des données restent strictement sur ce serveur.</strong>
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="border border-border bg-paper p-3.5">
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                    <Cpu className="h-3.5 w-3.5 text-slate" />
                    <span>MODÈLES IA LOCAUX (OLLAMA)</span>
                  </div>
                  <p className="text-xs leading-relaxed text-stone">
                    L&apos;inférence linguistique et les embeddings vectoriels s&apos;exécutent
                    localement dans le conteneur privé d&apos;ARA, sans télémétrie ni entraînement
                    externe sur vos cours.
                  </p>
                </div>

                <div className="border border-border bg-paper p-3.5">
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                    <Database className="h-3.5 w-3.5 text-forest" />
                    <span>STOCKAGE &amp; VECTEURS PGVECTOR</span>
                  </div>
                  <p className="text-xs leading-relaxed text-stone">
                    La base PostgreSQL + pgvector, vos fichiers PDF et vos espaces privés sont
                    hébergés en un seul endroit maîtrisé et réservé à votre promotion Oniris.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 border border-border bg-card px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                <ShieldCheck className="h-4 w-4 shrink-0 text-forest" />
                <span>
                  ACCÈS PROTÉGÉ PAR COMPTE VALIDÉ · RÔLES ÉTUDIANTS / RESPONSABLE D&apos;UE · AUCUN
                  PISTAGE PUBLICITAIRE
                </span>
              </div>
            </div>
          )}

          {stepIndex === 2 && (
            <div className="space-y-3">
              <div
                className="border border-border bg-forest/10 p-4"
                style={{ borderLeft: "3px solid #3B7A57" }}
              >
                <div className="mb-1 flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-forest">
                  <Leaf className="h-4 w-4" />
                  <span>SERVEUR HÉBERGÉ DE MANIÈRE ÉCOLOGIQUE</span>
                </div>
                <p className="text-xs leading-relaxed text-ink">
                  L&apos;infrastructure d&apos;ARA est hébergée sur un environnement sobre et bas
                  carbone. Chaque choix technique vise à limiter l&apos;empreinte énergétique des
                  calculs IA.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="border border-border bg-paper p-3.5">
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                    <Users className="h-3.5 w-3.5 text-forest" />
                    <span>MUTUALISATION COMMUNAUTAIRE</span>
                  </div>
                  <p className="text-xs leading-relaxed text-stone">
                    Le premier étudiant qui génère un Quiz, des Flashcards ou une Fiche sur un cours
                    le rend automatiquement <strong>public pour toute la promo</strong> : inutile de
                    recalculer 150 fois la même synthèse.
                  </p>
                </div>

                <div className="border border-border bg-paper p-3.5">
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                    <Clock className="h-3.5 w-3.5 text-amber" />
                    <span>TRAITEMENTS AUX HEURES CREUSES (00H–07H)</span>
                  </div>
                  <p className="text-xs leading-relaxed text-stone">
                    Lorsqu&apos;un PDF est déposé, l&apos;indexation vectorielle lourde et la
                    pré-génération des contenus publics sont lissées la nuit entre{" "}
                    <strong>00h00 et 07h00</strong> pour préserver les ressources la journée.
                  </p>
                </div>
              </div>
            </div>
          )}

          {stepIndex === 3 && (
            <div className="space-y-3">
              <div className="border border-border bg-paper p-4">
                <p className="mb-3 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                  VOS 3 RÉFLEXES DÈS AUJOURD&apos;HUI
                </p>
                <ol className="space-y-2.5 text-xs text-ink">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center bg-ink font-mono text-[10px] font-bold text-card">
                      1
                    </span>
                    <span>
                      Ouvrez une <strong>UE</strong> dans l&apos;onglet <strong>MES UE</strong> pour
                      parcourir les chapitres ou déposer un polycopié PDF.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center bg-ink font-mono text-[10px] font-bold text-card">
                      2
                    </span>
                    <span>
                      Dans l&apos;onglet <strong>Studio IA</strong>, consultez les ressources
                      publiques déjà prêtes (95% du cours) ou lancez une génération{" "}
                      <strong>Privée Custom</strong> avec votre contexte précis sur ce que vous
                      voulez approfondir.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center bg-ink font-mono text-[10px] font-bold text-card">
                      3
                    </span>
                    <span>
                      Appuyez sur <span className="border border-border bg-card px-1 font-mono text-[10px]">Ctrl+K</span>{" "}
                      pour rechercher un mot-clé dans tous les PDF ou ouvrez l&apos;assistant{" "}
                      <strong>Spix</strong> en bas à droite.
                    </span>
                  </li>
                </ol>
              </div>

              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                VOUS POURREZ ROUVRIR CE GUIDE À TOUT MOMENT VIA LE BOUTON{" "}
                <span className="font-semibold text-ink">[ GUIDE ONIRIS ]</span> DANS LA BARRE
                SUPÉRIEURE.
              </p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-paper px-5 py-3.5">
          <button
            type="button"
            onClick={() => setStepIndex((prev) => Math.max(0, prev - 1))}
            disabled={isFirst}
            className="inline-flex items-center gap-1.5 border border-border bg-card px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>PRÉCÉDENT</span>
          </button>

          <div className="flex items-center gap-1.5">
            {STEPS.map((s, idx) => (
              <span
                key={s.code}
                className={`h-1.5 w-5 transition-colors ${
                  idx === stepIndex ? "bg-ink" : "bg-border"
                }`}
              />
            ))}
          </div>

          {isLast ? (
            <button
              type="button"
              onClick={onComplete}
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>COMMENCER SUR ARA</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                setStepIndex((prev) => Math.min(STEPS.length - 1, prev + 1))
              }
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
            >
              <span>SUIVANT</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
