-- Widen cart money columns Int -> BigInt so high-denomination currencies (LBP,
-- IRR) can't overflow 32-bit Int (2,147,483,647 minor) on large carts.
-- Lossless in-place widening.
ALTER TABLE "carts" ALTER COLUMN "subtotal_minor" TYPE BIGINT;
ALTER TABLE "carts" ALTER COLUMN "delivery_minor" TYPE BIGINT;
ALTER TABLE "carts" ALTER COLUMN "total_minor" TYPE BIGINT;
ALTER TABLE "cart_items" ALTER COLUMN "unit_price_minor" TYPE BIGINT;
ALTER TABLE "cart_items" ALTER COLUMN "line_total_minor" TYPE BIGINT;
