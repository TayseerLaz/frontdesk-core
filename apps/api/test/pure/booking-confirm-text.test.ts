// Pure-logic gate for booking → calendar → meeting link. No database, no
// environment, so this runs on a developer machine.
//
// The rules here decide whether a customer is told to join a video call or to
// come to an address. Getting that backwards sends someone to the wrong place,
// and nothing in the system would report an error.
import { describe, expect, it } from 'vitest';

import {
  confirmationText,
  decideConfirm,
  isArabic,
  pickAttendeeEmail,
} from '../../src/lib/booking-confirm-text.js';

const BASE = {
  connected: true,
  pushBookings: true,
  meetingMode: 'online' as const,
  autoConfirm: true,
  hasAppointment: true,
};

describe('decideConfirm', () => {
  it('does everything when the tenant is set up for online meetings', () => {
    expect(decideConfirm(BASE)).toEqual({ push: true, withMeet: true, confirm: true });
  });

  it('creates no Meet link for an onsite business', () => {
    const d = decideConfirm({ ...BASE, meetingMode: 'onsite' });
    expect(d.push).toBe(true);
    expect(d.withMeet).toBe(false);
  });

  it('does nothing at all when no calendar is connected', () => {
    expect(decideConfirm({ ...BASE, connected: false })).toEqual({
      push: false,
      withMeet: false,
      confirm: false,
    });
  });

  it('does nothing when the tenant switched calendar pushing off', () => {
    expect(decideConfirm({ ...BASE, pushBookings: false })).toEqual({
      push: false,
      withMeet: false,
      confirm: false,
    });
  });

  it('never auto-confirms without a calendar — that was the product rule', () => {
    // "If it is added to google calendar, the AI approves the booking."
    // No calendar ⇒ a human still approves, exactly as before the feature.
    expect(decideConfirm({ ...BASE, connected: false }).confirm).toBe(false);
    expect(decideConfirm({ ...BASE, pushBookings: false }).confirm).toBe(false);
  });

  it('leaves a booking with no resolved time alone', () => {
    // Nothing to put on a calendar, so it stays for an operator to sort out.
    expect(decideConfirm({ ...BASE, hasAppointment: false })).toEqual({
      push: false,
      withMeet: false,
      confirm: false,
    });
  });

  it('can push without confirming, when the tenant wants to approve manually', () => {
    const d = decideConfirm({ ...BASE, autoConfirm: false });
    expect(d.push).toBe(true);
    expect(d.confirm).toBe(false);
  });
});

describe('pickAttendeeEmail', () => {
  it('finds the email answer', () => {
    expect(
      pickAttendeeEmail([
        { key: 'name', type: 'text', value: 'Sara' },
        { key: 'email', type: 'email', value: 'sara@example.com' },
      ]),
    ).toBe('sara@example.com');
  });

  it('returns null when the form collects no email — no invitation is sent', () => {
    expect(pickAttendeeEmail([{ key: 'name', type: 'text', value: 'Sara' }])).toBeNull();
    expect(pickAttendeeEmail([])).toBeNull();
    expect(pickAttendeeEmail(null)).toBeNull();
  });

  it('ignores a blank or malformed address rather than inviting nobody@', () => {
    expect(pickAttendeeEmail([{ key: 'email', type: 'email', value: '   ' }])).toBeNull();
    expect(pickAttendeeEmail([{ key: 'email', type: 'email', value: 'not-an-email' }])).toBeNull();
  });
});

describe('isArabic', () => {
  it('detects Arabic so the confirmation mirrors the customer', () => {
    expect(isArabic('بدي احجز موعد')).toBe(true);
    expect(isArabic('I want to book')).toBe(false);
    expect(isArabic(null)).toBe(false);
  });
});

describe('confirmationText', () => {
  it('carries the Meet link for an online booking', () => {
    const t = confirmationText({
      when: 'Wednesday 5 August, 10:00',
      arabic: false,
      meetLink: 'https://meet.google.com/abc-defg-hij',
      businessName: 'Hadar Clinic',
    });
    expect(t).toContain('https://meet.google.com/abc-defg-hij');
    expect(t).toContain('Wednesday 5 August, 10:00');
    expect(t).toContain('Hadar Clinic');
  });

  it('carries the address instead when there is no link', () => {
    const t = confirmationText({
      when: 'Wednesday 5 August, 10:00',
      arabic: false,
      address: 'Hamra Street, Beirut',
    });
    expect(t).toContain('Hamra Street, Beirut');
    expect(t).not.toMatch(/meet\.google/);
  });

  it('never shows both a link and an address', () => {
    const t = confirmationText({
      when: 'x',
      arabic: false,
      meetLink: 'https://meet.google.com/abc',
      address: 'Hamra Street',
    });
    expect(t).toContain('meet.google.com');
    expect(t).not.toContain('Hamra Street');
  });

  it('answers in Arabic when the customer wrote in Arabic', () => {
    const t = confirmationText({ when: '١٠:٠٠', arabic: true, meetLink: 'https://meet.google.com/x' });
    expect(t).toContain('تم تأكيد موعدك');
    expect(t).toContain('https://meet.google.com/x');
  });

  it('still confirms when neither link nor address is known', () => {
    const t = confirmationText({ when: 'Wednesday 5 August, 10:00', arabic: false });
    expect(t).toContain('confirmed');
    expect(t).toContain('Wednesday 5 August, 10:00');
  });
});
