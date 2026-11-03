# Cloud deployment

## Cloudflare Workers + Containers

The Worker routes every HTTP, streaming MCP, OAuth, and device WebSocket request
to one named Node relay container. The existing agent still runs on your desktop;
this does not deploy a desktop agent inside Cloudflare.

**Persistence is mandatory and external to the container.** All relay SQL goes
through a private container outbound handler to a separate SQLite Durable Object.
Users, devices, API keys, OAuth clients/codes/tokens, pairing records, and audit
records survive container replacement. There is no public database endpoint.
Writes are acknowledged after the Durable Object transaction commits. A database
outage fails the operation rather than silently falling back to ephemeral disk.
Active WebSockets and pending consent pages are transient; reconnect/restart the
OAuth flow after a restart. Cookies use a stable configured session secret.

### Prerequisites and deployment

- Node 24, Docker with a running daemon, and an authenticated Cloudflare account.
- Cloudflare Containers requires an eligible Workers Paid account. Confirm pricing
  and plan eligibility yourself; these commands do not purchase or upgrade a plan.
- Keep the existing working relay running until the new endpoint has passed checks.

From `deploy/cloudflare`:

```sh
npm ci
npm run check
npx wrangler whoami
# Use the actual final workers.dev URL or a configured custom domain.
npx wrangler secret put PUBLIC_URL
npx wrangler secret put BRC_ADMIN_PASSWORD
npx wrangler secret put BRC_SESSION_SECRET
npm run deploy
```

Enter secrets interactively, never put them in source control or command arguments.
Use a long random admin password and a session secret of at least 32 characters.
Do not rotate the session secret on every deploy. The Worker refuses to serve when
required configuration is missing or the request origin differs from PUBLIC_URL.
`max_instances: 1` and a fixed routing name preserve the single-process device hub.
Do not enable random load balancing or add instances without distributed hub work.

After container provisioning (which may take several minutes):

1. Check `/health` and `/.well-known/oauth-authorization-server` via HTTPS.
2. Log in, pair a test device, and exercise `/mcp` with authorization.
3. Restart/redeploy the container. Verify that the same device, OAuth registration,
   and API key still work; the agent should reconnect its WebSocket.
4. Only then change the production agent/client relay URL. Keep the prior endpoint
   available for rollback. Do not delete or recreate the `RelayDatabase` namespace.

The Node relay uses a bounded synchronous SQL bridge to preserve its existing
store interface. It blocks its event loop while each database RPC completes, so
this deployment is intended for a personal/small relay, not high throughput.
Timeouts fail closed and writes are never automatically retried; an interrupted
write may have committed, so inspect state before retrying an administrative action.

### Local validation

`npm run check` validates Worker types. `wrangler deploy --dry-run` also requires
Docker. `--containers-rollout=none --dry-run` validates the Worker bundle only and
is not evidence that the container image builds or that deployment succeeded.
Run root `pnpm build`, `pnpm test:unit`, `pnpm test:e2e`, and
`node --test packages/relay/test/remote-sqlite.test.mjs` before release.

## Other managed containers

The existing `packages/relay/Dockerfile` remains portable. Build from repository
root and run one replica with a persistent read/write volume mounted at `/data`:

```sh
docker build -f packages/relay/Dockerfile -t brc-relay .
docker run --env-file /secure/path/relay.env -p 3000:3000 \
  --mount type=volume,source=brc-data,target=/data brc-relay
```

Set `PUBLIC_URL=https://your-relay.example`, `BRC_ADMIN_PASSWORD`, and a stable
`BRC_SESSION_SECRET`; `BRC_DB=/data/relay.sqlite` is the image default. Set
`TRUST_PROXY=true` only when the ingress strips and replaces forwarding headers.
Your platform must support long-lived WebSockets and HTTP streaming, preserve the
volume on redeploy, and route all requests to one replica. For Kubernetes use a
single StatefulSet replica and a retained PVC; for services without persistent
volumes do not deploy the local SQLite mode. Back up SQLite with its online backup
API (including WAL consistency), not by copying a live database file alone.

An optional compatible external SQL RPC service may be selected with
`BRC_SQL_ENDPOINT=https://...` and `BRC_SQL_TOKEN`. This is an internal privileged
service, not a public client API. HTTPS and token authentication are required except
for the exact private Cloudflare virtual origin `http://brc-storage`.

References:
- https://developers.cloudflare.com/containers/get-started/
- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/configuration/workers-connections/
- https://developers.cloudflare.com/containers/faq/
