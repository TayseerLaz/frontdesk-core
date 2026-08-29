# Deploy hardening (Tier 3)

Closes audit finding **F-13** (password SSH + flat-file secrets + broken
auto-deploy) and makes releases repeatable, auditable, and reversible.

## 1. Health-gated deploy with auto-rollback — DONE
`infra/scripts/redeploy.sh` now rolls the code back to the last known-good SHA
and restarts if `/health` doesn't come up after a deploy (exit non-zero so the
operator/CI knows the intended release failed). Migrations are forward-only and
backward-compatible by convention, so only code is reverted. Disable with
`NO_AUTO_ROLLBACK=1` for a deliberate migration-breaking release.

## 2. Key-only SSH (do this MANUALLY — never remotely flip it blind)
> ⚠️ Disabling password auth over an active password session can lock you out.
> Do every step and **verify key login in a SECOND terminal** before disabling
> passwords. Keep the current session open until you've confirmed.

```bash
# On your laptop:
ssh-keygen -t ed25519 -C "deploy@platform" -f ~/.ssh/platform_deploy
ssh-copy-id -p 269 -i ~/.ssh/platform_deploy.pub platform@91.92.108.178
# NEW terminal — prove key login works BEFORE locking down:
ssh -p 269 -i ~/.ssh/platform_deploy platform@91.92.108.178 'echo key-login-ok'
```
Then, on the server, in `/etc/ssh/sshd_config`:
```
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```
`sudo systemctl reload ssh` (NOT restart, so your session survives) and
re-verify in a fresh terminal. Add `fail2ban` for the SSH port as defence in depth.

## 3. Rotate the password that was shared in chat
The deploy password was sent in plaintext over chat — **treat it as compromised**
and rotate it (`passwd` on the server) once key auth is confirmed working.

## 4. Secrets out of a flat file
`.env.production` (chmod 600) is acceptable for one box; at multi-VM it must be
distributed securely. Options, easiest → strongest:
- **SOPS + age** (fits — you already use `age` for backups): commit
  `.env.production.enc` to a private repo, decrypt on deploy with the age key
  held only on the servers. Versioned, auditable, no plaintext at rest in git.
- **HashiCorp Vault / cloud secrets manager**: dynamic secrets + audit log +
  rotation. More moving parts; revisit when the team grows.
Either way: one canonical source, synced to every app node by the deploy.

## 5. Fix auto-deploy (optional, removes the manual SSH step)
`deploy.yml` is currently `workflow_dispatch`-only because the hosted runner
can't reach the server (account-level). To restore push-to-deploy without that
account: install a **self-hosted GitHub Actions runner** on `vm-app-1` (or the LB
node), then re-add the `push: [main]` trigger. The runner already has network +
keys to the box, so the SSH-account restriction no longer applies. Gate it behind
the CI hard-gates (tenant-isolation etc.) so a red test can't deploy.
