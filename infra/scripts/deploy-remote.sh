#!/usr/bin/env bash
# Server-side deploy script. Invoked over SSH by .github/workflows/deploy.yml.
#
# The workflow exports the following env vars before calling us:
#   - NEW_OPENAI_API_KEY, NEW_OPENAI_MODEL, NEW_EMAIL_SMTP_*, NEW_EMAIL_FROM,
#     NEW_WASABI_*, NEW_GOOGLE_TTS_*, NEW_ELEVENLABS_*, NEW_WEB_DOMAIN,
#     NEW_API_DOMAIN, NEW_ACME_EMAIL — feed the .env.production sync step
#   - INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD — feed the super-admin seed
#     and the /opt/aligned/secrets/super-admin.txt write
#
# This file lives in the repo (not generated) so the GitHub Actions
# expression-length limit (21 000 chars per ${{ }} block) doesn't apply.
# Edit here, push, deploy.

set -euo pipefail
cd /opt/aligned/app

echo "=== sync env vars from GH secrets/vars into .env.production (idempotent) ==="
# Updates existing lines in place; appends if missing. Empty
# values are skipped so we never blank an existing on-disk
# value when a secret/var is unset upstream. Defaults applied
# for non-secret config the operator hasn't bothered to set.
python3 - <<'PY'
import os, re
DEFAULTS = {
    'OPENAI_MODEL': 'gpt-4o-mini',
    'EMAIL_SMTP_HOST': 'email-smtp.us-east-1.amazonaws.com',
    'EMAIL_SMTP_PORT': '587',
    'EMAIL_SMTP_SECURE': 'false',
    'EMAIL_FROM': 'ALIGNED <noreply@alignbot.aligned-tech.com>',
    'WASABI_BUCKET': 'alignbotbucket',
    'WASABI_REGION': 'eu-central-1',
    'WASABI_ENDPOINT': 'https://s3.eu-central-1.wasabisys.com',
    'WASABI_PUBLIC_URL_BASE': 'https://alignbotbucket.s3.eu-central-1.wasabisys.com',
    'GOOGLE_TTS_DEFAULT_VOICE_EN': 'en-US-Neural2-J',
    'GOOGLE_TTS_DEFAULT_VOICE_AR': 'ar-XA-Wavenet-B',
    'ELEVENLABS_MODEL': 'eleven_multilingual_v2',
    'WEB_DOMAIN': 'hader.ai',
    'API_DOMAIN': 'api.hader.ai',
    'ACME_EMAIL': 'ops@hader.ai',
}
web_domain = os.environ.get('NEW_WEB_DOMAIN', '') or DEFAULTS['WEB_DOMAIN']
api_domain = os.environ.get('NEW_API_DOMAIN', '') or DEFAULTS['API_DOMAIN']
# Cookie domain must cover both portal + api hostnames so the
# refresh cookie set by api.* is sent on requests from app.*.
# We pick the longest shared suffix (with leading dot).
def _shared_suffix(a: str, b: str) -> str:
    pa, pb = a.split('.'), b.split('.')
    shared = []
    while pa and pb and pa[-1] == pb[-1]:
        shared.insert(0, pa.pop())
        pb.pop()
    return '.' + '.'.join(shared) if len(shared) >= 2 else '.' + a
cookie_domain = _shared_suffix(web_domain, api_domain)
updates = {
    'OPENAI_API_KEY':           os.environ.get('NEW_OPENAI_API_KEY', ''),
    'OPENAI_MODEL':             os.environ.get('NEW_OPENAI_MODEL', '') or DEFAULTS['OPENAI_MODEL'],
    'EMAIL_SMTP_USER':          os.environ.get('NEW_EMAIL_SMTP_USER', ''),
    'EMAIL_SMTP_PASS':          os.environ.get('NEW_EMAIL_SMTP_PASS', ''),
    'EMAIL_SMTP_HOST':          os.environ.get('NEW_EMAIL_SMTP_HOST', '') or DEFAULTS['EMAIL_SMTP_HOST'],
    'EMAIL_SMTP_PORT':          os.environ.get('NEW_EMAIL_SMTP_PORT', '') or DEFAULTS['EMAIL_SMTP_PORT'],
    'EMAIL_SMTP_SECURE':        os.environ.get('NEW_EMAIL_SMTP_SECURE', '') or DEFAULTS['EMAIL_SMTP_SECURE'],
    'EMAIL_FROM':               os.environ.get('NEW_EMAIL_FROM', '') or DEFAULTS['EMAIL_FROM'],
    'WASABI_ACCESS_KEY_ID':     os.environ.get('NEW_WASABI_ACCESS_KEY_ID', ''),
    'WASABI_SECRET_ACCESS_KEY': os.environ.get('NEW_WASABI_SECRET_ACCESS_KEY', ''),
    'WASABI_BUCKET':            os.environ.get('NEW_WASABI_BUCKET', '') or DEFAULTS['WASABI_BUCKET'],
    'WASABI_REGION':            os.environ.get('NEW_WASABI_REGION', '') or DEFAULTS['WASABI_REGION'],
    'WASABI_ENDPOINT':          os.environ.get('NEW_WASABI_ENDPOINT', '') or DEFAULTS['WASABI_ENDPOINT'],
    'WASABI_PUBLIC_URL_BASE':   os.environ.get('NEW_WASABI_PUBLIC_URL_BASE', '') or DEFAULTS['WASABI_PUBLIC_URL_BASE'],
    'GOOGLE_TTS_API_KEY':       os.environ.get('NEW_GOOGLE_TTS_API_KEY', ''),
    'GOOGLE_TTS_DEFAULT_VOICE_EN': os.environ.get('NEW_GOOGLE_TTS_DEFAULT_VOICE_EN', '') or DEFAULTS['GOOGLE_TTS_DEFAULT_VOICE_EN'],
    'GOOGLE_TTS_DEFAULT_VOICE_AR': os.environ.get('NEW_GOOGLE_TTS_DEFAULT_VOICE_AR', '') or DEFAULTS['GOOGLE_TTS_DEFAULT_VOICE_AR'],
    'ELEVENLABS_API_KEY':       os.environ.get('NEW_ELEVENLABS_API_KEY', ''),
    'ELEVENLABS_VOICE_ID':      os.environ.get('NEW_ELEVENLABS_VOICE_ID', ''),
    'ELEVENLABS_MODEL':         os.environ.get('NEW_ELEVENLABS_MODEL', '') or DEFAULTS['ELEVENLABS_MODEL'],
    'WEB_DOMAIN':       web_domain,
    'API_DOMAIN':       api_domain,
    'ACME_EMAIL':       os.environ.get('NEW_ACME_EMAIL', '') or DEFAULTS['ACME_EMAIL'],
    # Derived from web/api domain — keep these aligned so we
    # never end up with a CORS or cookie scope mismatch.
    # NOTE: the portal runs under Next.js basePath '/app' (next.config.ts),
    # so all email/redirect links the API mints must carry the /app prefix.
    'WEB_PUBLIC_URL':   f'https://{web_domain}/app',
    'API_PUBLIC_URL':   f'https://{api_domain}',
    'NEXT_PUBLIC_API_URL': f'https://{api_domain}',
    'CORS_ORIGINS':     f'https://{web_domain}',
    'COOKIE_DOMAIN':    cookie_domain,
}
path = '.env.production'
with open(path) as f:
    content = f.read()
def shell_quote(v: str) -> str:
    # Always emit double-quoted with $/`/"/\ escaped. Safe for
    # `source .env.production` regardless of whether v contains
    # spaces, <>, &, |, etc.
    escaped = v.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    return f'"{escaped}"'

for key, val in updates.items():
    # Skip blank values for secrets so we don't wipe an
    # already-set on-disk credential.
    if not val and key not in DEFAULTS:
        continue
    pat = re.compile(rf'^{re.escape(key)}=.*$', re.M)
    line = f'{key}={shell_quote(val)}'
    # Use a callable replacement so backslashes/backreferences
    # in `val` aren't interpreted by re.sub.
    content = pat.sub(lambda _m, _l=line: _l, content) if pat.search(content) else content.rstrip() + '\n' + line + '\n'
with open(path, 'w') as f:
    f.write(content)
PY
chmod 600 .env.production

# Load production env before any pnpm/prisma commands so DATABASE_URL
# etc. are available to the build scripts.
set -a; source .env.production; set +a

echo "=== git pull ==="
git fetch --all --quiet
git reset --hard origin/main

echo "=== ensure ffmpeg is installed (TTS voice-note transcode) ==="
# The bot uses ffmpeg to remux ElevenLabs / Google TTS output
# into OGG/Opus for WhatsApp's voice-note validator. The npm
# ffmpeg-static binary segfaults silently on this host's
# libc setup, so we install system ffmpeg via apt. Idempotent.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[ffmpeg] not found — installing via apt"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ffmpeg
fi
ffmpeg -version 2>&1 | head -1 || echo "[ffmpeg] install failed — voice replies will fall back to text"

echo "=== pnpm install ==="
# Clear node_modules first so pnpm doesn't hit its
# "modules directories will be removed and reinstalled — Proceed?"
# prompt (which hangs the SSH action because there's no TTY to
# answer it). pnpm symlink structures occasionally trip
# `rm -rf` with "Directory not empty"; mv to a sacrificial
# path first so the working tree is clean even if the
# background rm hits a transient issue.
for d in node_modules apps/*/node_modules packages/*/node_modules; do
  if [ -e "$d" ]; then
    mv "$d" "$d.old.$$" 2>/dev/null || true
    rm -rf "$d.old.$$" 2>/dev/null || true
  fi
done
# Belt + braces: anything left over gets force-removed; we
# don't care if individual files refused since pnpm install
# will overwrite below.
rm -rf node_modules apps/*/node_modules packages/*/node_modules 2>/dev/null || true

# Verify the pnpm content-addressable store still has Next's
# build polyfills — that file went missing once, breaking
# next build with ENOENT after a "reused N, downloaded 0"
# install. If missing, prune the store so the next install
# re-fetches every package fresh. Idempotent / cheap.
NEXT_POLYFILL=$(find ~/.local/share/pnpm/store ~/.pnpm-store -path '*next*/dist/build/polyfills/polyfill-nomodule.js' 2>/dev/null | head -1 || true)
if [ -z "$NEXT_POLYFILL" ]; then
  echo "[pnpm-store] Next.js polyfill missing — pruning store"
  pnpm store prune 2>&1 | tail -3 || true
fi
# NODE_ENV=production was sourced from .env.production above,
# which makes pnpm skip devDependencies (incl. prisma CLI,
# tsx, typescript, tiptap). Force include them for the install
# step only — runtime envs aren't affected by this override.
NODE_ENV=development pnpm install --frozen-lockfile

# Post-install integrity check. The pre-install probe above
# only inspects the pnpm store. The store can hold the right
# file while the installed symlink-chain into apps/web/
# ends up broken (we've hit this multiple times — webpack
# blows up on a missing next polyfill). If the resolved file
# isn't readable, force a fresh fetch + reinstall.
POLYFILL_PATH=$(node -e "try{console.log(require.resolve('next/dist/build/polyfills/polyfill-nomodule.js',{paths:['apps/web']}))}catch(e){}" 2>/dev/null || true)
if [ -z "$POLYFILL_PATH" ] || [ ! -f "$POLYFILL_PATH" ]; then
  echo "[pnpm-post-install] Next.js polyfill unreachable after install — force-reinstalling"
  pnpm store prune 2>&1 | tail -3 || true
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
  NODE_ENV=development pnpm install --frozen-lockfile --force
fi

echo "=== clear stale tsbuildinfo + dists (prevents incremental ghost builds) ==="
find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete || true
rm -rf packages/shared/dist packages/db/dist apps/api/dist apps/worker/dist

echo "=== prisma generate + migrate deploy + RLS ==="
pnpm --filter @platform/db exec prisma generate
# Recover from any previously-failed migrations whose body has
# been fixed in this or a later commit. Idempotent: if the
# migration is absent or already applied, the resolve errors
# out and we swallow it. The migration is then retried by
# `migrate deploy`.
for m in \
  20260427120000_inbox_threads_tags_notes_canned_templates \
  20260427150000_phase3_billing_branding; do
  pnpm --filter @platform/db exec prisma migrate resolve \
    --rolled-back "$m" 2>/dev/null || true
done
pnpm --filter @platform/db exec prisma migrate deploy
# RLS is idempotent — safe to re-apply every deploy.
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f packages/db/prisma/rls.sql || true

echo "=== build ==="
# shared + db emit compiled JS so they can be loaded by api/worker
# at runtime. api + worker themselves are run through tsx (no build).
pnpm --filter @platform/shared build
pnpm --filter @platform/db build
# Clear Next.js output and rebuild the web bundle
rm -rf apps/web/.next
pnpm --filter @platform/web build

echo "=== bootstrap super-admin (idempotent) ==="
INITIAL_ADMIN_EMAIL="$INITIAL_ADMIN_EMAIL" \
INITIAL_ADMIN_PASSWORD="$INITIAL_ADMIN_PASSWORD" \
pnpm --filter @platform/db exec tsx ./seed/super-admin.ts

echo "=== voice inbound audit (which message types are actually reaching us) ==="
# Counts of every inbound message_type the ALIGNED org has
# ever received. If audio/voice = 0, Meta isn't routing
# voice notes to our webhook — most likely Meta-side
# webhook subscription doesn't include media events.
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -At -c "
  SELECT message_type, COUNT(*) AS total,
         COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours') AS last_24h,
         COUNT(*) FILTER (WHERE received_at > now() - interval '1 hour') AS last_1h,
         MAX(received_at) AS most_recent
  FROM whatsapp_messages m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.direction = 'inbound' AND lower(o.name) = 'aligned'
  GROUP BY message_type
  ORDER BY total DESC;
" || echo "[voice-inbound-audit] query failed (non-fatal)"
echo ""
echo "--- last 5 inbound audio rows on ALIGNED (id, when, body-preview, body-bytes) ---"
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -At -c "
  SELECT
    LEFT(m.id::text, 8),
    to_char(m.received_at AT TIME ZONE 'UTC', 'HH24:MI:SS'),
    COALESCE(LEFT(m.body, 80), '(null)'),
    COALESCE(LENGTH(m.body), 0) AS body_len,
    COALESCE(m.from_number, '(null)') AS from_number,
    COALESCE(LEFT(m.meta_message_id, 20), '(null)') AS wamid
  FROM whatsapp_messages m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.direction = 'inbound'
    AND m.message_type IN ('audio','voice')
    AND lower(o.name) = 'aligned'
  ORDER BY m.received_at DESC
  LIMIT 5;
" || echo "[voice-inbound-audit] follow-up query failed (non-fatal)"
echo ""

echo "--- bot_config.replyMode + ttsProvider on ALIGNED (the actual saved values) ---"
# Tells us whether the operator's chosen reply mode actually
# persisted. If reply_mode='text' here, the bot will ALWAYS
# send text regardless of inbound type — switch to
# match_customer/voice on /bot to enable voice replies.
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -At -c "
  SELECT
    LEFT(bc.organization_id::text, 8) AS org,
    bc.reply_mode,
    bc.tts_provider,
    COALESCE(bc.tts_voice_name, '(unset)') AS tts_voice,
    CASE WHEN bc.deployed_at IS NULL THEN 'no' ELSE 'yes' END AS deployed
  FROM bot_configs bc
  JOIN organizations o ON o.id = bc.organization_id
  WHERE lower(o.name) = 'aligned';
" || echo "[bot-config-audit] query failed (non-fatal)"
echo ""

echo "--- last 10 inbound+next-outbound on ALIGNED (did audio inbound → audio out?) ---"
# Pairs each recent inbound with the bot's very next outbound
# so we can see at-a-glance whether audio inbounds are getting
# audio replies. The 'match' column is the smoking gun:
#   audio→audio = working, audio→text = TTS/transcode failed
#   or replyMode='text', text→text = expected.
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -At -c "
  WITH recent_in AS (
    SELECT m.id, m.received_at, m.message_type, m.from_number, m.organization_id
    FROM whatsapp_messages m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.direction = 'inbound' AND lower(o.name) = 'aligned'
    ORDER BY m.received_at DESC LIMIT 10
  )
  SELECT
    to_char(ri.received_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS at,
    ri.message_type AS inbound,
    COALESCE((
      SELECT mo.message_type
      FROM whatsapp_messages mo
      WHERE mo.organization_id = ri.organization_id
        AND mo.direction = 'outbound'
        AND mo.received_at > ri.received_at
        AND (mo.raw_payload->>'sentBy') = 'bot'
      ORDER BY mo.received_at ASC LIMIT 1
    ), '(no bot reply)') AS bot_reply,
    CASE
      WHEN ri.message_type IN ('audio','voice') THEN '<-- audio inbound'
      ELSE ''
    END AS note
  FROM recent_in ri
  ORDER BY ri.received_at DESC;
" || echo "[bot-reply-pairing] query failed (non-fatal)"
echo ""

echo "--- last 10 AUDIO inbounds on ALIGNED + their next bot reply ---"
# Filtered version that only looks at audio/voice inbounds.
# If 'bot_reply' shows 'audio' the TTS path worked end-to-end.
# If it shows 'text' the bot fell back — TTS or transcode
# error in the logs around that timestamp.
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -At -c "
  WITH recent_audio AS (
    SELECT m.id, m.received_at, m.message_type, m.from_number, m.organization_id,
           LEFT(COALESCE(m.body,'(no body)'), 50) AS body_preview
    FROM whatsapp_messages m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.direction = 'inbound'
      AND m.message_type IN ('audio','voice')
      AND lower(o.name) = 'aligned'
    ORDER BY m.received_at DESC LIMIT 10
  )
  SELECT
    to_char(ra.received_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS at,
    ra.message_type AS inbound,
    ra.body_preview,
    COALESCE((
      SELECT mo.message_type
      FROM whatsapp_messages mo
      WHERE mo.organization_id = ra.organization_id
        AND mo.direction = 'outbound'
        AND mo.received_at > ra.received_at
        AND (mo.raw_payload->>'sentBy') = 'bot'
      ORDER BY mo.received_at ASC LIMIT 1
    ), '(no bot reply)') AS bot_reply
  FROM recent_audio ra
  ORDER BY ra.received_at DESC;
" || echo "[audio-pairing] query failed (non-fatal)"
echo ""

echo "=== voice / TTS configuration audit ==="
# Print which TTS providers are configured in .env.production
# so we can diagnose voice-mode failures without server access.
# Only prints presence (yes/no), never the key itself.
python3 - <<'PY'
import os
keys = [
    'GOOGLE_TTS_API_KEY',
    'GOOGLE_TTS_DEFAULT_VOICE_EN',
    'GOOGLE_TTS_DEFAULT_VOICE_AR',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    'ELEVENLABS_MODEL',
]
try:
    with open('.env.production') as f:
        lines = f.read().splitlines()
except Exception as e:
    print(f"[tts-audit] could not read .env.production: {e}")
    lines = []
kv = {}
for ln in lines:
    if ln and not ln.startswith('#') and '=' in ln:
        k, v = ln.split('=', 1)
        kv[k.strip()] = v.strip().strip('"').strip("'")
for k in keys:
    v = kv.get(k, '')
    if k.endswith('API_KEY') or k.endswith('VOICE_ID'):
        state = 'set' if v and len(v) > 10 else ('SHORT/INVALID' if v else 'MISSING')
        print(f"  {k}: {state} (length {len(v)})")
    else:
        print(f"  {k}: {v or '(unset)'}")
print("")
print("[tts-audit] If GOOGLE_TTS_API_KEY = MISSING and ELEVENLABS_API_KEY = MISSING,")
print("           voice replies will ALWAYS fall back to text. Add at least one")
print("           provider's key as a GH Actions secret and redeploy.")
PY

echo "=== sync Wasabi bucket CORS to portal domain ==="
# Script lives under apps/api/scripts so Node's ESM package
# resolution walks up into apps/api/node_modules and finds
# @aws-sdk/client-s3. Idempotent: PutBucketCors replaces.
node apps/api/scripts/wasabi-cors.mjs || echo "[wasabi-cors] failed — image uploads may still be blocked"

echo "=== ensure Caddy Permissions-Policy allows microphone ==="
# The portal's voice-note recorder (MediaRecorder in the
# inbox composer) needs same-origin microphone access. The
# live Caddyfile previously had microphone=() which the
# browser enforces as a hard block. Patch any occurrence
# of microphone=() to microphone=(self) and reload. The
# in-place edit is idempotent — reruns on already-patched
# configs are a no-op.
if [ -f /etc/caddy/Caddyfile ]; then
  if sudo grep -q "microphone=()" /etc/caddy/Caddyfile; then
    sudo sed -i 's|microphone=()|microphone=(self)|g' /etc/caddy/Caddyfile
    echo "Caddyfile patched; reloading caddy."
    sudo systemctl reload caddy || sudo systemctl restart caddy || true
  else
    echo "Caddyfile already allows microphone or uses a different syntax — leaving alone."
  fi
fi

echo "=== sync domain in live Caddyfile to WEB_DOMAIN / API_DOMAIN ==="
# If WEB_DOMAIN/API_DOMAIN changed since last deploy, rewrite
# only those two hostnames in /etc/caddy/Caddyfile in place.
# We do NOT regenerate from the repo template because the live
# Caddyfile has bare-metal upstreams (localhost:3000 / :4000)
# whereas the template ships with Docker Compose names. Sed +
# validate + reload is the minimal-risk path.
#
# The previous domain is whichever hostname currently appears
# at the top of a site-address block (line starts with a
# hostname followed by `{`). We replace any of the known prior
# domains we've used with $WEB_DOMAIN / $API_DOMAIN.
if [ -f /etc/caddy/Caddyfile ] && [ -n "${WEB_DOMAIN:-}" ] && [ -n "${API_DOMAIN:-}" ]; then
  if sudo grep -qE "(^|[^.[:alnum:]])($WEB_DOMAIN|$API_DOMAIN)([[:space:]{]|$)" /etc/caddy/Caddyfile; then
    echo "Caddyfile already references $WEB_DOMAIN + $API_DOMAIN; skipping rewrite."
  else
    echo "Rewriting Caddyfile hostnames to $WEB_DOMAIN / $API_DOMAIN"
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
    # Replace known prior public hostnames. Add a new entry
    # here whenever you switch domains again so older live
    # files can still be auto-upgraded.
    sudo sed -i \
      -e "s/alignbot\.aligned-tech\.com/$WEB_DOMAIN/g" \
      -e "s/api\.aligned-tech\.com/$API_DOMAIN/g" \
      -e "s/app\.aligned\.example/$WEB_DOMAIN/g" \
      -e "s/api\.aligned\.example/$API_DOMAIN/g" \
      /etc/caddy/Caddyfile
    if sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
      sudo systemctl reload caddy || sudo systemctl restart caddy
      echo "Caddyfile updated + reloaded. Caddy will fetch fresh certs for new domains via ACME on first request."
    else
      echo "WARN: rewritten Caddyfile failed validation; restoring backup."
      LATEST_BAK=$(ls -t /etc/caddy/Caddyfile.bak.* 2>/dev/null | head -1)
      if [ -n "$LATEST_BAK" ]; then sudo cp "$LATEST_BAK" /etc/caddy/Caddyfile; fi
    fi
  fi
fi

echo "=== restart services ==="
sudo systemctl restart aligned-api aligned-worker aligned-web
sleep 5
sudo systemctl is-active aligned-api aligned-worker aligned-web

echo "=== update /opt/aligned/secrets/super-admin.txt ==="
umask 077
cat > /opt/aligned/secrets/super-admin.txt <<EOF
ALIGNED super-admin — last updated by deploy at $(date -u +%FT%TZ)
Portal: https://${WEB_DOMAIN}
Email:  ${INITIAL_ADMIN_EMAIL}
Pass:   ${INITIAL_ADMIN_PASSWORD}
Change the password from /settings/profile once signed in.
EOF
chmod 600 /opt/aligned/secrets/super-admin.txt
