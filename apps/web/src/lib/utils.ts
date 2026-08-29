import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(firstName?: string | null, lastName?: string | null, email?: string | null) {
  const a = (firstName ?? '').trim().charAt(0);
  const b = (lastName ?? '').trim().charAt(0);
  if (a || b) return `${a}${b}`.toUpperCase();
  return (email ?? '?').trim().charAt(0).toUpperCase();
}

export function fullName(firstName?: string | null, lastName?: string | null, fallback = '') {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || fallback;
}
