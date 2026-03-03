import { AlertTriangle, Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { getSecretRequest } from '@/lib/db/secret-requests';
import SecretForm from './SecretForm';

interface Props {
  params: Promise<{ uid: string }>;
}

export default async function RetrieveSecretPage({ params }: Props) {
  const { uid } = await params;
  const request = await getSecretRequest(uid);

  if (!request) {
    return <ErrorPage icon="not-found" message="This link is invalid or does not exist." />;
  }

  if (new Date() > request.expiresAt || request.status === 'expired') {
    return <ErrorPage icon="expired" message="This link has expired." />;
  }

  if (request.status !== 'pending') {
    return (
      <ErrorPage
        icon="used"
        message={
          request.status === 'fulfilled'
            ? 'This link has already been used. The information was submitted.'
            : 'This link has already been used. The request was declined.'
        }
      />
    );
  }

  return <SecretForm uid={uid} name={request.name} reason={request.reason} />;
}

function ErrorPage({ icon, message }: { icon: 'not-found' | 'expired' | 'used'; message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="pt-8 pb-8 flex flex-col items-center text-center gap-4">
          {icon === 'expired' ? (
            <Clock className="h-12 w-12 text-muted-foreground" />
          ) : (
            <AlertTriangle className="h-12 w-12 text-muted-foreground" />
          )}
          <div>
            <h2 className="text-xl font-semibold">Link unavailable</h2>
            <p className="text-muted-foreground text-sm mt-2">{message}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
