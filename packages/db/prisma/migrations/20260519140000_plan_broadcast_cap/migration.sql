-- Plan adjustments:
--   1. New column `monthly_broadcast_cap` on plans — a separate ceiling
--      on broadcast campaigns started per calendar month, distinct from
--      monthly_message_cap (which counts individual outbound messages).
--   2. Re-seed the Growth tier: 2,500 → 1,000 products, 20 → 10 members.
--      Starter is unchanged.
--   3. Set per-tier broadcast caps: Free 1, Starter 5, Growth 10,
--      Enterprise NULL (unlimited).
--   4. Refresh the `highlights` arrays so the marketing copy shown in
--      the billing UI matches the new numbers.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS monthly_broadcast_cap INT;

UPDATE plans
   SET monthly_broadcast_cap = 1,
       highlights = ARRAY['25 products','500 messages/mo','1 broadcast/mo','2 team members']
 WHERE code = 'free';

UPDATE plans
   SET monthly_broadcast_cap = 5,
       highlights = ARRAY['250 products','5,000 messages/mo','5 broadcasts/mo','5 team members','Email support']
 WHERE code = 'starter';

-- Growth: lower product + member caps to 1,000 / 10 and add the broadcast quota.
UPDATE plans
   SET product_cap = 1000,
       member_cap = 10,
       monthly_broadcast_cap = 10,
       highlights = ARRAY['1,000 products','50,000 messages/mo','10 broadcasts/mo','10 team members','Priority support','API connectors']
 WHERE code = 'growth';

UPDATE plans
   SET monthly_broadcast_cap = NULL,
       highlights = ARRAY['Unlimited products','Unlimited messages','Unlimited broadcasts','Unlimited team','SLA + dedicated support','SSO + audit']
 WHERE code = 'enterprise';
