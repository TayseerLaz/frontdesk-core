// Demo tenant: Aurora Skin Clinic — a clinic that both books appointments and
// sells retail products, which is exactly the shape the CALL-E phone-task
// feature was built for (a booking to confirm AND a cash-on-delivery order to
// confirm).
//
// Idempotent-ish: it wipes the tenant's demo-owned rows first, then re-seeds, so
// you can run it repeatedly before a demo or a recording. It deliberately does
// NOT touch users, memberships, api keys or wallets.
//
// Run:
//   set -a; . ./.env; set +a
//   pnpm --filter @platform/db exec tsx --conditions=source scripts/seed-demo-clinic.ts
//
// Phone numbers are Ofcom's reserved fictional range (+44 7700 900xxx) so no
// real person can ever be dialed, and the United Kingdom is one of CALL-E's
// supported regions, so Confirm by phone works out of the box.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CURRENCY = 'GBP';
const TZ = 'Europe/London';

const now = new Date();
const daysAgo = (d: number, h = 10, m = 0) =>
  new Date(now.getTime() - d * 86_400_000 - (now.getHours() - h) * 3_600_000 - (now.getMinutes() - m) * 60_000);
const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3_600_000);

async function main() {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organization found — run `pnpm bootstrap` first.');
  const orgId = org.id;
  console.warn(`[seed-clinic] tenant ${org.slug} (${orgId})`);

  // ---------------------------------------------------------------- wipe
  // Order matters: children before parents.
  await prisma.$executeRawUnsafe(
    `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE organization_id = $1::uuid)`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM carts WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM bookings WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(
    `DELETE FROM whatsapp_notes WHERE thread_id IN (SELECT id FROM whatsapp_threads WHERE organization_id = $1::uuid)`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM whatsapp_messages WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM whatsapp_threads WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM products WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM services WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM categories WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM faqs WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(`DELETE FROM policies WHERE organization_id = $1::uuid`, orgId);
  // Start every demo with an empty call list, so the first row a viewer sees is
  // the call they just watched being placed.
  await prisma.$executeRawUnsafe(`DELETE FROM phone_tasks WHERE organization_id = $1::uuid`, orgId);
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE organization_id = $1::uuid
       AND action IN ('refresh_token_grace_reissue', 'refresh_token_reuse_detected',
                      'login_succeeded', 'login_failed', 'logout')`, orgId);
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE organization_id = $1::uuid AND entity_type IN
       ('product','service','cart','booking','contact','faq','policy','phone_task','phone_task_settings')`, orgId);
  console.warn('[seed-clinic] wiped demo rows');

  // ---------------------------------------------------------------- identity
  await prisma.organization.update({
    where: { id: orgId },
    data: { name: 'Aurora Skin Clinic' },
  });

  await prisma.businessInfo.upsert({
    where: { organizationId: orgId },
    update: {
      legalName: 'Aurora Skin Clinic',
      tagline: 'Dermatology-led skincare and aesthetic treatments',
      about:
        'Aurora Skin Clinic is a skin and aesthetics clinic in Marylebone, London. We offer consultation-led facials, peels, laser and microneedling, and we retail the same professional skincare our practitioners use in clinic. Appointments are by booking only. Retail orders are delivered across London, paid in cash on delivery.',
      websiteUrl: 'https://example.com',
      timezone: TZ,
      currency: CURRENCY,
      operatingHours: {
        mon: [{ open: '09:00', close: '18:00' }],
        tue: [{ open: '09:00', close: '18:00' }],
        wed: [{ open: '09:00', close: '18:00' }],
        thu: [{ open: '09:00', close: '20:00' }],
        fri: [{ open: '09:00', close: '18:00' }],
        sat: [{ open: '10:00', close: '16:00' }],
        sun: [],
      },
    },
    create: {
      organizationId: orgId,
      legalName: 'Aurora Skin Clinic',
      tagline: 'Dermatology-led skincare and aesthetic treatments',
      about: 'Aurora Skin Clinic is a skin and aesthetics clinic in Marylebone, London.',
      timezone: TZ,
      currency: CURRENCY,
    },
  });

  // ---------------------------------------------------------------- catalog
  const mkCat = (name: string, slug: string, sortOrder: number) =>
    prisma.category.create({ data: { organizationId: orgId, name, slug, sortOrder } });
  const catSkincare = await mkCat('Skincare', 'skincare', 1);
  const catSun = await mkCat('Sun care', 'sun-care', 2);
  const catTreatments = await mkCat('Treatments', 'treatments', 3);

  const products = [
    ['AUR-SER-01', 'Vitamin C Brightening Serum', 'skincare', 6800, '15% L-ascorbic acid serum for dullness and uneven tone.', catSkincare.id],
    ['AUR-SER-02', 'Retinal 0.05% Night Serum', 'retinal-night-serum', 7400, 'Encapsulated retinaldehyde for fine lines. Evening use only.', catSkincare.id],
    ['AUR-CLN-01', 'Gentle Amino Cleanser', 'gentle-amino-cleanser', 2900, 'pH-balanced daily cleanser for sensitive and post-treatment skin.', catSkincare.id],
    ['AUR-MST-01', 'Ceramide Repair Moisturiser', 'ceramide-repair-moisturiser', 4200, 'Barrier-repair moisturiser with ceramides and squalane.', catSkincare.id],
    ['AUR-SPF-01', 'Mineral SPF 50 Fluid', 'mineral-spf-50-fluid', 3600, 'Invisible zinc-based SPF 50, safe after peels and laser.', catSun.id],
    ['AUR-SPF-02', 'Tinted SPF 30 Day Cream', 'tinted-spf-30-day-cream', 3200, 'Light tint with daily broad-spectrum protection.', catSun.id],
    ['AUR-EYE-01', 'Peptide Eye Complex', 'peptide-eye-complex', 4800, 'Peptide and caffeine complex for puffiness and crepiness.', catSkincare.id],
    ['AUR-MSK-01', 'Post-Treatment Recovery Mask', 'post-treatment-recovery-mask', 2600, 'Cooling hydrogel mask used after peels and microneedling.', catSkincare.id],
  ] as const;

  const productRows = [];
  for (const [sku, name, slug, priceMinor, shortDescription, categoryId] of products) {
    productRows.push(
      await prisma.product.create({
        data: {
          organizationId: orgId, sku, name, slug, priceMinor, currency: CURRENCY,
          shortDescription, description: shortDescription, categoryId,
          isAvailable: true, searchText: `${name} ${shortDescription}`,
        },
      }),
    );
  }

  const services = [
    ['Skin Consultation', 'skin-consultation', 30, 5000, 'A 30-minute consultation with a practitioner, including a skin scan and a written plan.'],
    ['Signature Hydrating Facial', 'signature-hydrating-facial', 60, 11000, 'Deep-cleanse, exfoliation and hydration. No downtime.'],
    ['Medical-Grade Chemical Peel', 'chemical-peel', 45, 15000, 'Targeted peel for pigmentation and texture. Expect light flaking for 3 days.'],
    ['Microneedling with Serum', 'microneedling', 75, 22000, 'Collagen induction therapy with a bespoke serum. 24 hours of redness.'],
    ['Laser Hair Removal — Small Area', 'laser-hair-removal-small', 20, 8000, 'Diode laser, small area such as upper lip or underarms.'],
    ['LED Light Therapy', 'led-light-therapy', 25, 4500, 'Red and blue LED for inflammation and post-treatment recovery.'],
  ] as const;

  const serviceRows = [];
  for (const [name, slug, durationMinutes, basePriceMinor, shortDescription] of services) {
    serviceRows.push(
      await prisma.service.create({
        data: {
          organizationId: orgId, name, slug, durationMinutes, basePriceMinor, currency: CURRENCY,
          shortDescription, description: shortDescription, categoryId: catTreatments.id,
          isAvailable: true, searchText: `${name} ${shortDescription}`,
        },
      }),
    );
  }

  const faqs = [
    ['Do I need a consultation before a treatment?', 'Yes for peels, microneedling and laser. A 30-minute skin consultation is £50 and is credited against your first treatment.'],
    ['How do I pay for a retail order?', 'Retail orders are cash on delivery across London. We confirm every order by phone before we dispatch it.'],
    ['How long does delivery take?', 'Orders placed before 2pm are delivered the next working day within London. We call to agree a delivery window.'],
    ['Can I reschedule my appointment?', 'Yes, up to 24 hours before. Inside 24 hours we charge 50% of the treatment price.'],
    ['Is the SPF safe after a peel?', 'Yes. The Mineral SPF 50 Fluid is the one we hand out in clinic after peels and laser.'],
    ['Do you treat sensitive or rosacea-prone skin?', 'Yes. Book a skin consultation first and the practitioner will build a plan around your tolerance.'],
  ] as const;
  for (const [question, answer] of faqs) {
    await prisma.fAQ.create({
      data: { organizationId: orgId, question, answer, isPublished: true, searchText: `${question} ${answer}` },
    });
  }

  await prisma.policy.create({
    data: {
      organizationId: orgId, kind: 'shipping', title: 'Delivery',
      content: 'We deliver across Greater London, next working day for orders placed before 2pm. Delivery is £4.50 and is free over £75. All retail orders are cash on delivery and are confirmed by phone before dispatch.',
    },
  });
  await prisma.policy.create({
    data: {
      organizationId: orgId, kind: 'return', title: 'Returns',
      content: 'Unopened products can be returned within 14 days. Opened skincare cannot be returned for hygiene reasons unless it caused a reaction, in which case we ask you to book a follow-up consultation.',
    },
  });
  console.warn('[seed-clinic] catalog, FAQs and policies');

  // ---------------------------------------------------------------- people
  // +44 7700 900xxx is Ofcom's reserved fictional range: never a real person.
  const people = [
    ['+447700900101', 'Amelia Hart', 'en-GB'],
    ['+447700900102', 'Priya Raman', 'en-GB'],
    ['+447700900103', 'Daniel Okafor', 'en-GB'],
    ['+447700900104', 'Sofia Marchetti', 'en-GB'],
    ['+447700900105', 'Hannah Weiss', 'en-GB'],
    ['+447700900106', 'Omar Haddad', 'en-GB'],
    ['+447700900107', 'Grace Lin', 'en-GB'],
    ['+447700900108', 'Tom Whitfield', 'en-GB'],
    ['+447700900109', 'Yasmin Farouk', 'en-GB'],
    ['+447700900110', 'Ruth Adeyemi', 'en-GB'],
  ] as const;

  const contacts = [];
  for (const [phoneE164, displayName, locale] of people) {
    contacts.push(
      await prisma.contact.create({
        data: { organizationId: orgId, phoneE164, displayName, locale, optedInAt: daysAgo(40) },
      }),
    );
  }
  console.warn(`[seed-clinic] ${contacts.length} contacts`);

  // ---------------------------------------------------------------- inbox
  type Turn = [dir: 'inbound' | 'outbound', body: string];
  const conversations: { who: number; status: 'open' | 'pending' | 'resolved' | 'escalated'; startedDaysAgo: number; humanReply?: boolean; turns: Turn[] }[] = [
    {
      who: 0, status: 'open', startedDaysAgo: 0,
      turns: [
        ['inbound', 'Hi! Do you have the vitamin C serum in stock?'],
        ['outbound', 'Hello! Yes, the Vitamin C Brightening Serum is £68 and in stock. Would you like me to add it to an order?'],
        ['inbound', 'Yes please, and the mineral SPF too'],
        ['outbound', 'Added 1× Vitamin C Brightening Serum and 1× Mineral SPF 50 Fluid. That is £104 plus £4.50 delivery. Can I take your delivery address?'],
        ['inbound', '18 Devonshire Place, London W1G 6HP'],
        ['outbound', 'Thank you. Your order total is £108.50, cash on delivery. We will call to confirm before we dispatch.'],
      ],
    },
    {
      who: 1, status: 'open', startedDaysAgo: 1,
      turns: [
        ['inbound', 'can i book a peel for next week?'],
        ['outbound', 'Of course. A Medical-Grade Chemical Peel is 45 minutes at £150, and it needs a consultation first if you have not had one with us. Have you been in before?'],
        ['inbound', 'no first time'],
        ['outbound', 'No problem. I have booked you a 30-minute Skin Consultation. The £50 is credited against your peel.'],
        ['inbound', 'perfect thank you'],
      ],
    },
    {
      who: 2, status: 'resolved', startedDaysAgo: 3,
      turns: [
        ['inbound', 'What time do you close on Thursday?'],
        ['outbound', 'We are open until 8pm on Thursdays, and 6pm the rest of the week. Saturdays we close at 4pm.'],
        ['inbound', 'great thanks'],
      ],
    },
    {
      who: 3, status: 'escalated', startedDaysAgo: 4, humanReply: true,
      turns: [
        ['inbound', 'My skin reacted to the retinal serum, it is very red'],
        ['outbound', 'I am sorry to hear that. Please stop using it and keep to the Gentle Amino Cleanser and the Ceramide Repair Moisturiser. I am passing this to a practitioner now.'],
        ['inbound', 'ok thank you'],
      ],
    },
    {
      who: 4, status: 'resolved', startedDaysAgo: 6,
      turns: [
        ['inbound', 'do you do laser on the upper lip'],
        ['outbound', 'Yes, Laser Hair Removal for a small area such as the upper lip is 20 minutes at £80.'],
        ['inbound', 'and how many sessions'],
        ['outbound', 'Most people need six sessions spaced four to six weeks apart. The practitioner will confirm at your consultation.'],
        ['inbound', 'ok ill book soon'],
      ],
    },
    {
      who: 5, status: 'resolved', startedDaysAgo: 9,
      turns: [
        ['inbound', 'Is the SPF ok to use after microneedling?'],
        ['outbound', 'Yes. The Mineral SPF 50 Fluid is the one we hand out in clinic after microneedling and peels.'],
        ['inbound', 'thanks!'],
      ],
    },
    {
      who: 6, status: 'resolved', startedDaysAgo: 12,
      turns: [
        ['inbound', 'how much is the hydrating facial'],
        ['outbound', 'The Signature Hydrating Facial is 60 minutes at £110, with no downtime.'],
        ['inbound', 'lovely, ill come with a friend'],
      ],
    },
  ];

  const threads: Record<number, string> = {};
  let totalMessages = 0;
  for (const convo of conversations) {
    const person = contacts[convo.who]!;
    const start = daysAgo(convo.startedDaysAgo, 11, 15);
    const last = new Date(start.getTime() + convo.turns.length * 4 * 60_000);
    const inbound = convo.turns.filter((t) => t[0] === 'inbound').length;
    const outbound = convo.turns.length - inbound;
    const preview = convo.turns[convo.turns.length - 1]![1];

    const thread = await prisma.whatsAppThread.create({
      data: {
        organizationId: orgId, channel: 'whatsapp',
        customerPhone: person.phoneE164, customerName: person.displayName,
        customerWhatsappName: person.displayName,
        status: convo.status, lastMessageAt: last,
        lastMessagePreview: preview.slice(0, 120),
        inboundCount: inbound, outboundCount: outbound,
        lastInboundAt: last, createdAt: start,
        searchText: `${person.displayName} ${person.phoneE164} ${convo.turns.map((t) => t[1]).join(' ')}`.slice(0, 2000),
      },
    });
    threads[convo.who] = thread.id;

    for (let i = 0; i < convo.turns.length; i += 1) {
      const [direction, body] = convo.turns[i]!;
      await prisma.whatsAppMessage.create({
        data: {
          organizationId: orgId, threadId: thread.id, direction, channel: 'whatsapp',
          messageType: 'text', body,
          fromNumber: direction === 'inbound' ? person.phoneE164 : null,
          toNumber: direction === 'inbound' ? null : person.phoneE164,
          metaStatus: direction === 'outbound' ? 'delivered' : null,
          // The dashboard and analytics count a reply as AI-handled when
          // rawPayload.sentBy === 'bot' (dashboard.routes.ts), so the seed has
          // to say who sent it or every chart reads 0% handled by AI.
          rawPayload: direction === 'outbound' ? { sentBy: convo.humanReply ? 'agent' : 'bot' } : undefined,
          receivedAt: new Date(start.getTime() + i * 4 * 60_000),
        },
      });
      totalMessages += 1;
    }
  }
  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_threads SET updated_at = last_message_at WHERE organization_id = $1::uuid`, orgId);
  console.warn(`[seed-clinic] ${conversations.length} conversations, ${totalMessages} messages`);

  // ---------------------------------------------------------------- orders
  const P = (sku: string) => productRows.find((p) => p.sku === sku)!;
  const money = (n: number) => BigInt(n);

  async function makeCart(args: {
    who: number; status: string; items: { sku: string; qty: number }[];
    address: string; createdAt: Date; deliveryMinor?: number; paymentStatus?: string | null;
  }) {
    const person = contacts[args.who]!;
    const delivery = args.deliveryMinor ?? 450;
    const lines = args.items.map((it) => {
      const p = P(it.sku);
      return { p, qty: it.qty, line: (p.priceMinor ?? 0) * it.qty };
    });
    const subtotal = lines.reduce((s, l) => s + l.line, 0);
    const cart = await prisma.cart.create({
      data: {
        organizationId: orgId, threadId: threads[args.who] ?? null, channel: 'whatsapp',
        customerPhone: person.phoneE164, customerName: person.displayName,
        fields: [
          { key: 'address', label: 'Delivery address', type: 'text', required: true, value: args.address },
          { key: 'notes', label: 'Notes', type: 'text', required: false, value: '' },
        ],
        subtotalMinor: money(subtotal), deliveryMinor: money(delivery),
        totalMinor: money(subtotal + delivery), currency: CURRENCY,
        status: args.status, itemsCount: args.items.reduce((s, i) => s + i.qty, 0),
        paymentStatus: args.paymentStatus ?? null,
        createdAt: args.createdAt, updatedAt: args.createdAt,
      },
    });
    for (const l of lines) {
      await prisma.cartItem.create({
        data: {
          organizationId: orgId, cartId: cart.id, productId: l.p.id, sku: l.p.sku, name: l.p.name,
          quantity: l.qty, unitPriceMinor: money(l.p.priceMinor ?? 0), lineTotalMinor: money(l.line),
        },
      });
    }
    return cart;
  }

  // THE order for the demo: brand new, cash on delivery, waiting on a call.
  const heroCart = await makeCart({
    who: 0, status: 'new',
    items: [{ sku: 'AUR-SER-01', qty: 1 }, { sku: 'AUR-SPF-01', qty: 1 }],
    address: '18 Devonshire Place, London W1G 6HP',
    createdAt: new Date(now.getTime() - 12 * 60_000),
  });
  await makeCart({
    who: 4, status: 'confirmed',
    items: [{ sku: 'AUR-CLN-01', qty: 1 }, { sku: 'AUR-MST-01', qty: 1 }],
    address: '4 Weymouth Street, London W1W 5BU', createdAt: daysAgo(2, 15),
  });
  await makeCart({
    who: 6, status: 'completed',
    items: [{ sku: 'AUR-SPF-02', qty: 2 }],
    address: '77 Wimpole Street, London W1G 9RU', createdAt: daysAgo(5, 12),
  });
  await makeCart({
    who: 2, status: 'completed',
    items: [{ sku: 'AUR-EYE-01', qty: 1 }, { sku: 'AUR-MSK-01', qty: 3 }],
    address: '12 Harley Street, London W1G 9QD', createdAt: daysAgo(8, 16),
  });
  await makeCart({
    who: 5, status: 'cancelled',
    items: [{ sku: 'AUR-SER-02', qty: 1 }],
    address: '30 Marylebone Lane, London W1U 2NR', createdAt: daysAgo(11, 13),
  });
  console.warn('[seed-clinic] 5 orders (1 waiting on a confirmation call)');

  // ---------------------------------------------------------------- bookings
  async function makeBooking(args: {
    who: number; service: string; status: string; appointmentAt: Date | null; createdAt: Date;
  }) {
    const person = contacts[args.who]!;
    return prisma.booking.create({
      data: {
        organizationId: orgId, threadId: threads[args.who] ?? null, channel: 'whatsapp',
        customerPhone: person.phoneE164, customerName: person.displayName,
        fields: [
          { key: 'service', label: 'Treatment', type: 'text', required: true, value: args.service },
          { key: 'practitioner', label: 'Practitioner', type: 'text', required: false, value: 'Dr Elena Voss' },
        ],
        status: args.status, appointmentAt: args.appointmentAt,
        createdAt: args.createdAt, updatedAt: args.createdAt,
      },
    });
  }

  // THE booking for the demo: tomorrow morning, not yet confirmed.
  const heroBooking = await makeBooking({
    who: 1, service: 'Skin Consultation', status: 'new',
    appointmentAt: hoursFromNow(22), createdAt: daysAgo(1, 11),
  });
  await makeBooking({ who: 3, service: 'Signature Hydrating Facial', status: 'confirmed', appointmentAt: hoursFromNow(30), createdAt: daysAgo(2, 9) });
  await makeBooking({ who: 4, service: 'Laser Hair Removal — Small Area', status: 'confirmed', appointmentAt: hoursFromNow(54), createdAt: daysAgo(3, 14) });
  await makeBooking({ who: 6, service: 'Signature Hydrating Facial', status: 'completed', appointmentAt: daysAgo(4, 15), createdAt: daysAgo(9, 10) });
  await makeBooking({ who: 5, service: 'Microneedling with Serum', status: 'completed', appointmentAt: daysAgo(7, 11), createdAt: daysAgo(13, 12) });
  await makeBooking({ who: 2, service: 'Medical-Grade Chemical Peel', status: 'cancelled', appointmentAt: daysAgo(1, 17), createdAt: daysAgo(6, 9) });
  console.warn('[seed-clinic] 6 bookings (1 waiting on a confirmation call)');

  // Activity feed: real business events rather than infrastructure chatter.
  const admin = await prisma.user.findFirst({ where: { memberships: { some: { organizationId: orgId } } } });
  const feed: [string, string, string, Date][] = [
    ['cart_created', 'cart', 'Amelia Hart · 108.50 GBP', new Date(now.getTime() - 12 * 60_000)],
    ['booking_created', 'booking', 'Priya Raman · Skin Consultation', daysAgo(1, 11)],
    ['cart_created', 'cart', 'Hannah Weiss · 75.50 GBP', daysAgo(2, 15)],
    ['booking_updated', 'booking', 'Sofia Marchetti · confirmed', daysAgo(2, 9)],
    ['product_updated', 'product', 'Mineral SPF 50 Fluid · price', daysAgo(3, 10)],
    ['cart_updated', 'cart', 'Grace Lin · completed', daysAgo(5, 12)],
    ['product_created', 'product', 'Peptide Eye Complex', daysAgo(7, 9)],
    ['faq_created', 'faq', 'How do I pay for a retail order?', daysAgo(10, 14)],
  ];
  for (const [action, entityType, label, createdAt] of feed) {
    await prisma.auditLog.create({
      data: {
        organizationId: orgId, actorUserId: admin?.id ?? null,
        action: action as never, entityType, metadata: { label }, createdAt,
      },
    });
  }
  console.warn(`[seed-clinic] ${feed.length} activity entries`);

  console.warn('');
  console.warn('[seed-clinic] DEMO TARGETS');
  console.warn(`  order to confirm   ${heroCart.id}  ${contacts[0]!.displayName} ${contacts[0]!.phoneE164}`);
  console.warn(`  booking to confirm ${heroBooking.id}  ${contacts[1]!.displayName} ${contacts[1]!.phoneE164}`);
  console.warn('[seed-clinic] done.');
}

main()
  .catch((err) => {
    console.error('[seed-clinic] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
