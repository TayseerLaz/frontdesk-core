// Sequence management lives under /broadcasts now (tab "Sequences").
// This route stays as a redirect so existing bookmarks + outbound
// links keep working.
import { redirect } from 'next/navigation';

export default function SequencesRedirect() {
  redirect('/broadcasts?tab=sequences');
}
