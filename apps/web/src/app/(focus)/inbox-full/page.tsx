'use client';

import { InboxScreen } from '@/components/inbox/inbox-screen';

// Chrome-less, full-viewport inbox — opened in its own browser tab from the
// sidebar. Same component, same data, same permissions as the embedded /inbox;
// just bigger and free of the surrounding nav. Auth is enforced by the parent
// (focus) layout (redirect to /login when unauthenticated).
export default function InboxFullPage() {
  return <InboxScreen fullscreen />;
}
