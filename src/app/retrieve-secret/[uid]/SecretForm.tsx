'use client';

import { useState } from 'react';
import { Eye, EyeOff, Lock, CheckCircle, XCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

type State = 'idle' | 'submitting' | 'submitted' | 'declined' | 'error';

interface Props {
  uid: string;
  name: string;
  reason: string;
}

export default function SecretForm({ uid, name, reason }: Props) {
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function respond(action: 'submit' | 'decline') {
    setState('submitting');
    try {
      const res = await fetch(`/api/retrieve-secret/${uid}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value: action === 'submit' ? value : undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error ?? 'An error occurred. Please try again.');
        setState('error');
        return;
      }
      setState(action === 'submit' ? 'submitted' : 'declined');
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.');
      setState('error');
    }
  }

  if (state === 'submitted') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent className="pt-8 pb-8 flex flex-col items-center text-center gap-4">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <h2 className="text-xl font-semibold">Information submitted</h2>
            <p className="text-muted-foreground text-sm">
              Your agent has been notified. You can close this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === 'declined') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent className="pt-8 pb-8 flex flex-col items-center text-center gap-4">
            <XCircle className="h-12 w-12 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Request declined</h2>
            <p className="text-muted-foreground text-sm">
              Your agent has been notified that you declined. You can close this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="pb-2">
          <div className="flex flex-col items-center text-center gap-3 pt-2">
            <div className="rounded-full bg-primary/10 p-3">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Secure Information Request</h1>
              <p className="text-muted-foreground text-sm mt-1">
                Your agent is requesting sensitive information
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {/* Request details */}
          <div className="rounded-lg border bg-muted/40 p-4 flex flex-col gap-2">
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Requesting
              </span>
              <p className="font-semibold mt-0.5">{name}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Reason
              </span>
              <p className="text-sm mt-0.5 text-foreground/80">{reason}</p>
            </div>
          </div>

          {/* Input */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="secret-input">
              Enter your {name}
            </label>
            <div className="relative">
              <Input
                id="secret-input"
                type={showValue ? 'text' : 'password'}
                placeholder={`Paste your ${name} here…`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="pr-10 font-mono text-sm"
                disabled={state === 'submitting'}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={showValue ? 'Hide value' : 'Show value'}
              >
                {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Error */}
          {state === 'error' && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => respond('submit')}
              disabled={!value.trim() || state === 'submitting'}
              className="w-full"
            >
              {state === 'submitting' ? 'Submitting…' : 'Submit Securely'}
            </Button>
            <Button
              variant="outline"
              onClick={() => respond('decline')}
              disabled={state === 'submitting'}
              className="w-full text-muted-foreground"
            >
              Decline
            </Button>
          </div>

          {/* Security note */}
          <p className="text-center text-xs text-muted-foreground">
            This is a one-time link. Your information is sent directly to your agent and is not
            stored.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
