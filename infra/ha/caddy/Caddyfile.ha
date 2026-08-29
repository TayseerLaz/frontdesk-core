# Caddyfile (HA) — load-balances web + api across BOTH app nodes.
#
# This is the multi-node delta of infra/caddy/Caddyfile. Keep all the global
# options, security headers, on-demand-TLS, and the Next MIME fixes from that
# file VERBATIM — only the `reverse_proxy` upstreams change from one host to two.
# Run Caddy on a small dedicated LB node, or on each app node with the upstreams
# pointing at both private IPs (a client only needs to reach one healthy Caddy).
#
# Zero-downtime deploys: roll one app node at a time; Caddy's active health
# checks drain the node being rebuilt, so users only ever hit a healthy replica.

{$WEB_DOMAIN:app.hader.ai} {
    tls { protocols tls1.2 tls1.3 }
    encode zstd gzip
    # … (copy the full `header { … }` block + the @nextcss/@nextjs MIME fixes
    #     from infra/caddy/Caddyfile here — unchanged) …

    @nextcss path /_next/static/css/*
    header @nextcss Content-Type "text/css; charset=utf-8"
    @nextjs path /_next/static/chunks/*.js /_next/static/*.js
    header @nextjs Content-Type "application/javascript; charset=utf-8"

    reverse_proxy <VM_APP_1_IP>:3000 <VM_APP_2_IP>:3000 {
        # ip_hash pins a client to one replica so HTML + its build-hashed
        # assets always come from the SAME node (avoids cross-replica
        # build-hash mismatch during a rolling deploy).
        lb_policy ip_hash
        health_uri /
        health_interval 10s
        health_timeout 5s
        # Take a node out of rotation the moment it's unhealthy (deploy/restart).
        fail_duration 15s
    }
}

{$API_DOMAIN:api.hader.ai} {
    tls { protocols tls1.2 tls1.3 }
    encode zstd gzip
    # … (copy the full API `header { … }` block from infra/caddy/Caddyfile) …

    # The API is stateless → round-robin is ideal (better spread than ip_hash).
    reverse_proxy <VM_APP_1_IP>:4000 <VM_APP_2_IP>:4000 {
        lb_policy round_robin
        health_uri /health/ready          # only route to a node whose PG+Redis are up
        health_interval 10s
        health_timeout 5s
        fail_duration 15s
    }
}
