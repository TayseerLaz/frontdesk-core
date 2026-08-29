#!/usr/bin/env bash
# Brand-leak gate.
#
# This template names no product. The brand lives entirely in .env, so any
# hard-coded brand word is a regression — most often re-introduced by porting a
# fix across from the upstream repo. Runs in CI; run it locally before a port.
#
# Add a brand to FORBIDDEN when you fork this template for a new customer, so
# that customer's name can never leak back into the shared core.
set -uo pipefail

FORBIDDEN='hader|aligned|alinia'

# Genuine English uses of "aligned" that must not trip the gate.
ALLOW='right-aligned|left-aligned|center-aligned|centre-aligned|aligned with|aligned to|aligned on|misaligned|text-aligned'

hits=$(grep -rInIE "$FORBIDDEN" apps packages infra .github \
        --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
        --exclude-dir=.turbo --exclude-dir=test-results \
        --exclude="brand-check.sh" 2>/dev/null \
      | grep -viE "$ALLOW" || true)

if [ -n "$hits" ]; then
  echo "✗ brand leak — these must not name a product:"
  echo "$hits"
  exit 1
fi
echo "✓ no brand leak"
