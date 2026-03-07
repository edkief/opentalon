'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

export function OnboardingCheck({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkOnboarding = async () => {
      // Don't redirect if already on onboarding page
      if (pathname === '/dashboard/onboarding') {
        setLoading(false);
        return;
      }

      try {
        const res = await fetch('/api/onboarding/status');
        const data = await res.json();

        // Allow bypassing with ?skip=true query param
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('skip') === 'true') {
          setLoading(false);
          return;
        }

        if (!data.onboardingComplete) {
          router.push('/dashboard/onboarding');
        }
      } catch (err) {
        console.error('Failed to check onboarding status:', err);
      } finally {
        setLoading(false);
      }
    };

    checkOnboarding();
  }, [router, pathname]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return <>{children}</>;
}
