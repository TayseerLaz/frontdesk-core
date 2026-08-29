'use client';

import { InboxScreen } from '@/components/inbox/inbox-screen';

// Embedded inbox — rendered inside the dashboard shell (sidebar + top bar).
// The chrome-less, full-tab variant lives at /inbox-full and renders the
// same <InboxScreen> with `fullscreen`.
export default function InboxPage() {
  return <InboxScreen />;
}
