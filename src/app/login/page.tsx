"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { ArrowRight, Lock } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });

      if (res?.error) {
        setError("Identifiants incorrects. Vérifiez votre email et mot de passe.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Erreur de connexion au serveur.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-between bg-paper px-4 py-8 text-ink">
      <div className="mx-auto w-full max-w-md pt-8">
        {/* Masthead */}
        <div className="mb-6 flex items-center gap-3 border-b border-border pb-4">
          <div className="flex h-10 w-10 items-center justify-center bg-ink font-mono text-xs font-bold text-card">
            ARA
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">
              ARA · PROMO WORKSPACE
            </h1>
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              AUTHENTIFICATION LOCALE SÉCURISÉE
            </p>
          </div>
        </div>

        {/* Card */}
        <div
          className="border border-border bg-card p-6"
          style={{ borderTop: "3px solid #D99B26" }}
        >
          <div className="mb-5 flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-wider text-stone">
              ACCÈS ÉTUDIANT &amp; RESPONSABLES
            </span>
            <Lock className="h-4 w-4 text-stone" />
          </div>

          {error && (
            <div className="mb-4 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-stone">
                ADRESSE EMAIL
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="etudiant@universite.fr"
                className="w-full border border-border bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-stone/60 focus:border-ink focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-stone">
                MOT DE PASSE
              </label>
              <input
                type="password"
                required
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
              <span>{loading ? "CONNEXION..." : "SE CONNECTER"}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </form>

          <div className="mt-6 border-t border-border pt-4 text-center">
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              PAS ENCORE DE COMPTE ?
            </p>
            <Link
              href="/register"
              className="mt-2 inline-block w-full border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink transition-colors hover:bg-pinned"
            >
              CRÉER UN COMPTE PROMOTION
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
