 'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';

export default function DashboardLoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const nextParam = searchParams.get('next');
  const next = nextParam && nextParam.startsWith('/') ? nextParam : '/dashboard';

  useEffect(() => {
    setError(null);
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, next }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message =
          typeof data.error === 'string'
            ? data.error
            : res.status === 401
              ? 'Invalid token.'
              : 'Login failed. Please try again.';
        setError(message);
        return;
      }

      const redirectTo = typeof data.redirectTo === 'string' && data.redirectTo.startsWith('/')
        ? data.redirectTo
        : next;

      router.push(redirectTo);
      router.refresh();
    } catch {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-muted px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Link href="/">
            <img
              src="/opentalon_portrait.png"
              alt="OpenTalon"
              className="h-16 w-auto object-contain"
            />
          </Link>
          <div className="text-center space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">OpenTalon Dashboard Login</h1>
            <p className="text-sm text-muted-foreground">
              Enter your dashboard access token to continue.
            </p>
          </div>
        </div>

        <form
          className="space-y-4 rounded-lg border border-border bg-card p-4 shadow-sm"
          onSubmit={handleSubmit}
        >
          <div className="space-y-2">
            <label htmlFor="token" className="block text-sm font-medium">
              Access token
            </label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="••••••••••"
            />
            <p className="text-xs text-muted-foreground">
              This token is defined in your secrets configuration and protects all dashboard routes.
            </p>
          </div>

          {error && (
            <p className="text-xs text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {loading ? 'Signing in…' : 'Continue'}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          If you lost your token, update the <code>dashboard.password</code> entry in your secrets
          file and restart the app.
        </p>
      </div>
    </div>
  );
}

