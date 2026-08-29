-- Wallet billing audit actions (ADD VALUE runs alone, before the tables migration).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'wallet_topped_up';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'wallet_adjusted';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'wallet_price_changed';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'wallet_metering_toggled';
