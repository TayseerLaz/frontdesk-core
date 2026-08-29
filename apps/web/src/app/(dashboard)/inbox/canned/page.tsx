'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { CannedManager } from '@/components/inbox/canned-manager';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';

// Standalone route kept for deep links / the command palette. The same
// CannedManager is also embedded in the inbox header ("Canned replies" button),
// so operators manage them without leaving the conversation.
export default function CannedResponsesPage() {
  return (
    <>
      <PageHeader
        title="Canned responses"
        description="Quick-reply templates available in the inbox reply box."
        breadcrumbs={[{ label: 'Inbox', href: '/inbox' }, { label: 'Canned responses' }]}
        actions={
          <Button variant="secondary" asChild>
            <Link href="/inbox">
              <ArrowLeft className="size-4" /> Back to inbox
            </Link>
          </Button>
        }
      />
      <CannedManager />
    </>
  );
}
