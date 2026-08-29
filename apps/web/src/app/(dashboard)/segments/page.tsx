// Segments management lives under /broadcasts now (tab "Segments").
// This route stays as a redirect for back-compat with bookmarks +
// older links inside the platform (e.g. broadcast wizard step 2).
import { redirect } from 'next/navigation';

export default function SegmentsRedirect() {
  redirect('/broadcasts?tab=segments');
}
