import { cn } from '@/lib/utils';

// Identity avatar for a conversation contact, in the mockup's two types:
// tan for a regular contact, dark maroon when the AI is handling the thread.
// Two-letter initials from the visible name. Meta's Cloud API exposes no
// customer profile photo, so a generated avatar is the ceiling for WhatsApp
// identity visuals.

export function contactInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  // Phone-number-only "names" (no letters anywhere) collapse to a glyph — two
  // random digits read as noise, not identity.
  if (!words.some((w) => /\p{L}/u.test(w))) return '#';
  const first = words[0]!.charAt(0);
  const second = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + second).toUpperCase();
}

export function InitialsAvatar({
  name,
  ai = false,
  className,
}: {
  /** Visible display name the initials come from. */
  name: string;
  /** True when the AI is handling this thread — renders the dark variant. */
  ai?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex size-9 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold',
        ai ? 'bg-[#11334d] text-[#F3ECE0]' : 'bg-[#D9CCB8] text-[#4A1525]',
        className,
      )}
    >
      {contactInitials(name)}
    </div>
  );
}
