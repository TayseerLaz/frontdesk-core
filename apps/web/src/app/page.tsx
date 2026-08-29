import { redirect } from 'next/navigation';

export default function RootPage() {
  // Server-rendered redirect: dashboard if authed (cookie present), else login.
  // The dashboard layout will bounce back to /login if the refresh fails.
  redirect('/dashboard');
}
