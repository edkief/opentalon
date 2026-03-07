'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

type OnboardingStatus = {
  configExists: boolean;
  secretsExists: boolean;
  onboardingComplete: boolean;
};

type Mode = 'landing' | 'guided' | 'expert';

type GuidedStep = 'llm' | 'telegram' | 'dashboard' | 'review';

const LLM_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)', instruction: 'Get your API key from console.anthropic.com' },
  { value: 'openai', label: 'OpenAI (GPT)', instruction: 'Get your API key from platform.openai.com' },
  { value: 'mistral', label: 'Mistral', instruction: 'Get your API key from console.mistral.ai' },
  { value: 'minimax', label: 'Minimax', instruction: 'Sign up at platform.minimaxi.chat' },
  { value: 'google', label: 'Google (Gemini)', instruction: 'Get your API key from aistudio.google.com' },
];

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  mistral: 'mistral-medium-latest',
  minimax: 'MiniMax-Text-01',
  google: 'gemini-2.0-flash',
};

export default function OnboardingPage() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [mode, setMode] = useState<Mode>('landing');
  const [step, setStep] = useState<GuidedStep>('llm');
  const [busy, setBusy] = useState(false);

  // Guided mode form state
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [dashboardPassword, setDashboardPassword] = useState('');

  useEffect(() => {
    fetch('/api/onboarding/status')
      .then((res) => res.json())
      .then(setStatus)
      .catch(console.error);
  }, []);

  const handleSkip = async () => {
    setBusy(true);
    try {
      await fetch('/api/onboarding/skip', { method: 'POST' });
      window.location.href = '/dashboard';
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const handleGuidedComplete = async () => {
    setBusy(true);
    try {
      const configYaml = `llm:
  model: ${provider}/${DEFAULT_MODELS[provider]}

telegram:
  useLongPolling: true

onboarding:
  complete: true
`;

      const secretsYaml = `auth:
  ${provider}: "${apiKey}"

telegram:
  botToken: "${telegramToken}"

${dashboardPassword ? `dashboard:
  password: "${dashboardPassword}"
` : ''}`;

      await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configYaml, secretsYaml }),
      });
      window.location.href = '/dashboard';
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const handleExpertComplete = async () => {
    setBusy(true);
    try {
      await fetch('/api/onboarding/skip', { method: 'POST' });
      window.location.href = '/dashboard/config?skip=true';
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Landing view
  if (mode === 'landing') {
    return (
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold">Welcome to OpenTalon</h1>
          <p className="text-muted-foreground text-lg">
            OpenTalon is an AI-powered Telegram bot with long-term memory,
            built-in tools, and a web dashboard.
          </p>
        </div>

        {/* Skip option - always show, greyed out if no config */}
        <Card className={status.configExists ? "border-green-500/50 bg-green-500/5" : "opacity-50"}>
          <CardHeader>
            <CardTitle className={status.configExists ? "text-green-500" : ""}>
              Skip Onboarding
            </CardTitle>
            <CardDescription>
                Use your existing config files as-is.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleSkip}
              disabled={busy || !status.configExists}
              className="w-full"
              size="lg"
              variant={status.configExists ? "default" : "secondary"}
            >
              {status.configExists ? "Continue with existing config" : "No existing config"}
            </Button>
            {status.configExists && (
              <>
                <Separator className="my-4" />
                <p className="text-sm text-muted-foreground text-center">
                  If you need to reconfigure, use Initial Setup below.
                  <br />
                  <span className="text-yellow-500">Warning: This will overwrite your existing config.</span>
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Initial Setup */}
        <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setMode('expert')}>
          <CardHeader>
            <CardTitle>Initial Setup</CardTitle>
            <CardDescription>Set up default config files with comments</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>✓ Copies commented template files</li>
              <li>✓ Opens editor to customize</li>
            </ul>
          </CardContent>
        </Card>

        <div className="text-center text-sm text-muted-foreground">
          <p>Config files: {status.configExists ? 'Found' : 'Not found'} (config.yaml)</p>
          <p>Secrets: {status.secretsExists ? 'Found' : 'Not found'} (secrets.yaml)</p>
        </div>
      </div>
    );
  }

  // Expert mode
  if (mode === 'expert') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Initial Setup</h1>
          <Button variant="outline" onClick={() => setMode('landing')}>
            Back
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Minimum Setup Requirements</CardTitle>
            <CardDescription>
              Default commented config files will be installed for you to edit and manually configure.
              The minimum working setup requires a Telegram bot token and one LLM API key with model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h3 className="font-semibold mb-2">config.yaml</h3>
              <pre className="bg-muted p-4 rounded-md text-xs overflow-x-auto">
{`llm:
  model: anthropic/claude-sonnet-4-5

telegram:
  useLongPolling: true

onboarding:
  complete: true`}
              </pre>
            </div>

            <div>
              <h3 className="font-semibold mb-2">secrets.yaml</h3>
              <pre className="bg-muted p-4 rounded-md text-xs overflow-x-auto">
{`auth:
  anthropic: "sk-ant-api03-..."

telegram:
  botToken: "1234567890:ABCdefGHIjklmnopQRSTuvwxyz"`}
              </pre>
            </div>

            <Separator />

            <p className="text-sm text-muted-foreground text-center">
              Click below to setup the default configuration and open settings.
            </p>

            <Button onClick={handleExpertComplete} disabled={busy} className="w-full">
              Continue to Configuration
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Guided mode wizard
  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Guided Setup</h1>
        <Button variant="outline" onClick={() => setMode('landing')}>
          Back
        </Button>
      </div>

      {/* Progress indicator */}
      <div className="flex gap-2">
        {(['llm', 'telegram', 'dashboard', 'review'] as GuidedStep[]).map((s, i) => (
          <div
            key={s}
            className={`flex-1 h-2 rounded-full ${
              s === step ? 'bg-primary' :
              ['llm', 'telegram', 'dashboard', 'review'].indexOf(step) > i ? 'bg-primary/50' : 'bg-muted'
            }`}
          />
        ))}
      </div>

      {/* Step 1: LLM Provider */}
      {step === 'llm' && (
        <Card>
          <CardHeader>
            <CardTitle>Step 1: LLM Provider</CardTitle>
            <CardDescription>
              Choose which AI provider to use and enter your API key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-border rounded-md bg-background"
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <p className="text-sm text-muted-foreground mt-2">
                {LLM_PROVIDERS.find((p) => p.value === provider)?.instruction}
              </p>
            </div>

            <div>
              <label className="text-sm font-medium">API Key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-api03-..."
                className="mt-1"
              />
            </div>

            <div className="bg-muted p-3 rounded-md">
              <p className="text-sm">
                <span className="font-medium">Model:</span> {DEFAULT_MODELS[provider]}
              </p>
            </div>

            <Button onClick={() => setStep('telegram')} disabled={!apiKey.trim()} className="w-full">
              Continue
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Telegram */}
      {step === 'telegram' && (
        <Card>
          <CardHeader>
            <CardTitle>Step 2: Telegram Bot (Optional)</CardTitle>
            <CardDescription>
              Connect your Telegram bot to chat with the AI.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted p-4 rounded-md space-y-2">
              <p className="text-sm font-medium">How to create a Telegram bot:</p>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1">
                <li>Open Telegram and search for <span className="font-mono">@BotFather</span></li>
                <li>Send <span className="font-mono">/newbot</span> to create a new bot</li>
                <li>Follow the instructions and give your bot a name</li>
                <li>Copy the token BotFather gives you</li>
              </ol>
            </div>

            <div>
              <label className="text-sm font-medium">Bot Token</label>
              <Input
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                placeholder="1234567890:ABCdefGHIjklmnopQRSTuvwxyz"
                className="mt-1"
              />
            </div>

            <div className="flex gap-4">
              <Button onClick={() => setStep('llm')} variant="outline" className="flex-1">
                Back
              </Button>
              <Button onClick={() => setStep('dashboard')} className="flex-1">
                {telegramToken.trim() ? 'Continue' : 'Skip'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Dashboard Password */}
      {step === 'dashboard' && (
        <Card>
          <CardHeader>
            <CardTitle>Step 3: Dashboard Password (Optional)</CardTitle>
            <CardDescription>
              Protect your dashboard with a password.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              If you skip this, the dashboard will be accessible to anyone who knows the URL.
              This is fine for local development or if you're using another authentication method
              such as a reverse proxy.
            </p>

            <div>
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                value={dashboardPassword}
                onChange={(e) => setDashboardPassword(e.target.value)}
                placeholder="Enter a password (leave empty to skip)"
                className="mt-1"
              />
            </div>

            <div className="flex gap-4">
              <Button onClick={() => setStep('telegram')} variant="outline" className="flex-1">
                Back
              </Button>
              <Button onClick={() => setStep('review')} className="flex-1">
                {dashboardPassword.trim() ? 'Continue' : 'Skip'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: Review */}
      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle>Step 4: Review & Complete</CardTitle>
            <CardDescription>
              Review your settings before saving.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted p-4 rounded-md space-y-3">
              <div>
                <span className="text-sm font-medium">LLM Provider:</span>
                <span className="text-sm text-muted-foreground ml-2">{provider}/{DEFAULT_MODELS[provider]}</span>
              </div>
              <div>
                <span className="text-sm font-medium">Telegram:</span>
                <span className="text-sm text-muted-foreground ml-2">
                  {telegramToken ? 'Configured' : 'Not configured'}
                </span>
              </div>
              <div>
                <span className="text-sm font-medium">Dashboard:</span>
                <span className="text-sm text-muted-foreground ml-2">
                  {dashboardPassword ? 'Password protected' : 'Open access'}
                </span>
              </div>
            </div>

            <p className="text-sm text-yellow-500">
              This will write config.yaml and secrets.yaml to your workspace,
              preserving all comments and documentation from the template.
            </p>

            <div className="flex gap-4">
              <Button onClick={() => setStep('dashboard')} variant="outline" className="flex-1">
                Back
              </Button>
              <Button onClick={handleGuidedComplete} disabled={busy} className="flex-1">
                {busy ? 'Saving...' : 'Complete Setup'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
