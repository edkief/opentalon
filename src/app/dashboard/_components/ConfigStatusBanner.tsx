'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface StatusResponse {
  state: 'valid' | 'invalid' | 'missing';
  error: string | null;
}

export function ConfigStatusBanner() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  const check = () => {
    fetch('/api/config/status')
      .then((r) => r.json())
      .then((d: StatusResponse) => setStatus(d))
      .catch(() => {});
  };

  useEffect(() => {
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!status || status.state !== 'invalid') return null;

  return (
    <div className="w-full bg-red-600 text-white text-sm px-4 py-2 flex items-center justify-between z-50 min-w-0">
      <span className="truncate min-w-0">
        <strong>Configuration error:</strong>{' '}
        {status.error ?? 'Invalid configuration file.'}
      </span>
      <Link
        href="/dashboard/config"
        className="underline font-medium ml-4 hover:text-white/80 shrink-0"
      >
        Fix it →
      </Link>
    </div>
  );
}
