-- F8 (roadmap 2026-08-26) — contact external ERP reference ("SAP #").
-- Owner confirmed SAP numbers are unique per customer → partial UNIQUE index
-- (Prisma cannot express partial uniques; same situation as whatsapp_threads).
ALTER TABLE "contacts" ADD COLUMN "external_ref" TEXT;

CREATE UNIQUE INDEX "contacts_org_external_ref_uniq"
  ON "contacts"("organization_id", "external_ref")
  WHERE "external_ref" IS NOT NULL;
