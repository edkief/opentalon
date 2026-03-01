'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  // Sync with the class that the init script may have already applied
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {}
  };

  return (
    <Button variant="ghost" size="sm" onClick={toggle} className="w-full justify-start px-3 text-sm">
      {dark ? '☀ Light' : '☾ Dark'}
    </Button>
  );
}
