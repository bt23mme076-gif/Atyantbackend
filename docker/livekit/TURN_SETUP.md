# TURN-over-TLS-443 setup — fixing silent calls on college WiFi / mobile data

## Why calls go silent for some students

The product app connects to LiveKit with **`iceTransportPolicy: 'relay'`** (in the
frontend repo `Atyantfrontend`). That forces **100% of every call's audio through
the TURN server**. Right now TURN only listens on **UDP 3478**, which restrictive
college / corporate / mobile-carrier firewalls routinely block. When 3478 is
blocked there is **no fallback**, so the media never connects — the students say
*"am I audible?"*, the recording captures silence, and the pipeline marks the
session `no_audio`.

**Fix:** also offer **TURN over TLS on port 443**. TLS-on-443 is indistinguishable
from normal HTTPS traffic, so it passes through virtually every firewall. This is
the single highest-impact change for call reliability.

> This is VPS + DNS + reverse-proxy work. The repo config (`livekit.yaml`,
> `docker-compose.yml`) is the source of truth, but it must be **applied on the
> VPS** and **verified with a real cross-network test** — it cannot be validated
> from the codebase alone.

---

## What's already in the repo (the code side)

- `livekit.yaml` → `turn:` block enabled: `domain`, `tls_port: 5349`,
  `udp_port: 3478`, `external_tls: true`.
- `docker-compose.yml` → exposes `3478/udp` and `5349/tcp`.

## What you must do on the VPS (the infra side)

### 1. DNS
Add an A record pointing the TURN hostname at the VPS:
```
turn.meet.api.product.atyant.in.  A  187.127.133.111
```

### 2. Open the firewall
```bash
ufw allow 3478/udp        # TURN/UDP
ufw allow 443/tcp         # TURN/TLS (shared with HTTPS via Traefik SNI)
```

### 3. Traefik: route TLS :443 for the TURN host → LiveKit's TURN TCP port
Because Traefik already owns 443 (for `wss://meet.api.product.atyant.in`), add a
**TCP router with SNI** so only the TURN hostname is forwarded to LiveKit, and
Traefik terminates the TLS (Let's Encrypt issues the cert). Example dynamic config:

```yaml
tcp:
  routers:
    livekit-turn-tls:
      entryPoints: ["websecure"]        # your :443 entrypoint
      rule: "HostSNI(`turn.meet.api.product.atyant.in`)"
      tls:
        certResolver: letsencrypt
      service: livekit-turn
  services:
    livekit-turn:
      loadBalancer:
        servers:
          - address: "livekit:5349"     # LiveKit container, turn.tls_port
```
> In Dokploy, add this as a label/file-provider config on the LiveKit service.
> `external_tls: true` in `livekit.yaml` means LiveKit expects **plain TCP** on
> 5349 (Traefik already did the TLS), and advertises `turns:...:443` to clients.

### 4. Apply the LiveKit config
Copy the updated `livekit.yaml` to the VPS and restart:
```bash
docker compose -f docker/livekit/docker-compose.yml up -d --force-recreate livekit
```

### 5. Verify (do NOT skip — this is the only real proof)
Use the LiveKit / WebRTC TURN tester with a client **on a network that blocks UDP**
(e.g. tether to a locked-down college/office WiFi, or use a browser on mobile data):

- Trickle-ICE test: https://icetest.livekit.io — enter
  `turns:turn.meet.api.product.atyant.in:443?transport=tcp` with your API
  credentials and confirm **relay candidates over TLS** are gathered.
- Or run a real 2-person call across two different networks and confirm both hear
  each other, then check the session: `pipelineStatus` should become `completed`
  (not `no_audio`).

---

## The other half — reconsider forced `relay` (frontend repo)

Once TLS-443 TURN exists and is verified, revisit the frontend's
`iceTransportPolicy: 'relay'` (in `Atyantfrontend`, LiveKit room connect options):

- `relay` = every call funnels through TURN — simple but fragile (one weak TURN
  path affects everyone, and it wastes VPS bandwidth on calls that had a perfectly
  good direct path).
- `all` = ICE picks the best path (direct when possible) and **falls back to TURN**
  automatically. With a solid TLS-443 TURN as the safety net, `all` gives better
  quality for most calls and keeps the firewall-traversal guarantee.

Recommend switching to `all` **after** step 5 passes, and A/B testing on a few
sessions before rolling out.

## Status / retention note
Sessions from **July 4–6** are permanently unrecoverable (audio deleted by the old
60-min cron, no transcripts saved). Everything above only improves **future**
calls. The backend-side mitigations (honest `no_audio` flag, egress auto-restart,
recording never lost to a pipeline error) are already merged and reduce the blast
radius until this TURN work is done.
