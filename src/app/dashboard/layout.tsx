import { ConfigStatusBanner } from './_components/ConfigStatusBanner';
import { SidebarNav } from './_components/SidebarNav';
import { ErrorBoundary } from '@/components/error-boundary';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <ConfigStatusBanner />
      <div className="flex flex-1 overflow-hidden">
        <SidebarNav />
        <main className="flex-1 overflow-auto p-4 md:p-6 pr-14 md:pr-6">
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
