"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { ArrowRight, ShieldCheck, UserPlus } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/register", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { hasUsers?: boolean } | null) => {
        if (data && typeof data.hasUsers === "boolean") {
          setHasUsers(data.hasUsers);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!res.ok) {
        setError(data.error || "Impossible de créer le compte.");
        return;
      }

      const loginRes = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });

      if (loginRes?.error) {
        router.push("/login");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Erreur réseau lors de l'inscription.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-between bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-md pt-6">
        {/* Masthead */}
        <div className="mb-6 flex items-center gap-3 border-b border-border pb-4">
          <div className="flex h-10 w-10 items-center justify-center bg-ink font-mono text-xs font-bold text-card">
            ARA
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">
              ARA · INSCRIPTION PROMOTION
            </h1>
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              CRÉATION D&apos;IDENTIFIANT LOCAL
            </p>
          </div>
        </div>

        {/* First User Bootstrap Alert */}
        {hasUsers === false && (
          <div className="mb-4 flex items-start gap-2.5 border border-badge-text/30 bg-badge-bg p-3.5 text-badge-text">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-wider">
                BOOTSTRAP AUTOMATIQUE ACTIVÉ
              </p>
              <p className="mt-0.5 text-xs leading-relaxed">
                Aucun utilisateur enregistré. Ce premier compte recevra
                automatiquement les privilèges{" "}
                <span className="font-mono font-semibold">
                  RESPONSABLE D&apos;ANNÉE (YEAR_ADMIN)
                </span>
                .
              </p>
            </div>
          </div>
        )}

        <div
          className="border border-border bg-card p-6"
          style={{ borderTop: "3px solid #3B7A57" }}
        >
          <div className="mb-5 flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-wider text-stone">
              NOUVEAU MEMBRE
            </span>
            <UserPlus className="h-4 w-4 text-stone" />
          </div>

          {error && (
            <div className="mb-4 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-stone">
                NOM COMPLET
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Camille R."
                className="w-full border border-border bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-stone/60 focus:border-ink focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-stone">
                ADRESSE EMAIL
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="camille@universite.fr"
                className="w-full border border-border bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-stone/60 focus:border-ink focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-stone">
                MOT DE PASSE (6 CARACTÈRES MIN.)
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full border border-border bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-stone/60 focus:border-ink focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 border border-ink bg-ink px-4 py-2.5 font-mono text-xs uppercase tracking-wider text-card transition-colors hover:bg-ink/90 disabled:opacity-60"
            >
              <span>
                {loading ? "CRÉATION EN COURS..." : "VALIDER L'INSCRIPTION"}
              </span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </form>

          <div className="mt-6 border-t border-border pt-4 text-center">
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              DÉJÀ INSCRIT ?
            </p>
            <Link
              href="/login"
              className="mt-2 inline-block w-full border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink transition-colors hover:bg-pinned"
            >
              RETOUR À LA CONNEXION
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-md border-t border-border pt-4 text-center font-mono text-[10px] uppercase tracking-wider text-stone">
        ARA SINGLE-SERVER PLATFORM · 100 % LOCALHOST
      </div>
    </div>
  );
}
