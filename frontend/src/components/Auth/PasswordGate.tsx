import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const SESSION_KEY = "auth-token";

export function getAccessToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function PasswordGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "required" | "verified">(
    "loading",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then(async (data: { required: boolean }) => {
        if (!data.required) {
          sessionStorage.removeItem(SESSION_KEY);
          setStatus("verified");
          return;
        }

        const storedToken = sessionStorage.getItem(SESSION_KEY);
        if (storedToken) {
          // Validate stored token — it may be stale after a password change
          try {
            const res = await fetch("/api/auth/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: storedToken }),
            });
            const result = (await res.json()) as { ok: boolean };
            if (result.ok) {
              setStatus("verified");
              return;
            }
          } catch {
            // Validation failed — fall through to show password form
          }
          sessionStorage.removeItem(SESSION_KEY);
        }

        setStatus("required");
      })
      .catch(() => {
        // If we can't reach the server, let the app load normally
        setStatus("verified");
      });
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const hash = await hashPassword(password);
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: hash }),
      });
      const data = (await res.json()) as { ok: boolean };

      if (data.ok) {
        sessionStorage.setItem(SESSION_KEY, hash);
        setStatus("verified");
      } else {
        setError(t("auth.error"));
      }
    } catch {
      setError(t("auth.error"));
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-muted">{t("loading")}</p>
      </div>
    );
  }

  if (status === "verified") {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-[18px] bg-ink text-2xl font-semibold text-on-ink">
            A
          </div>
          <h1 className="text-xl font-semibold text-ink">
            {t("auth.title")}
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.placeholder")}
              autoFocus
              className="field-input"
            />
          </div>

          {error && (
            <p className="alert" data-tone="error">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !password}
            className="btn btn-primary w-full"
          >
            {submitting ? t("auth.verifying") : t("auth.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
