# Deployment

This guide covers the Docker Compose deployment path for OpenCodeProxyHub.

## Files

- `Dockerfile` builds the TypeScript backend and Web UI, then runs `node dist/main.js` in a production image.
- `docker-compose.yml` starts the app and Redis.
- `.env.docker.example` is the production environment template.
- `./data` is mounted into the app container as `/app/data` for JSON persistence.

## First Start

Create the Docker environment file:

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker` and set a strong `ADMIN_PASSWORD` before exposing the service. The default password is `admin`.

Start the stack:

```bash
docker compose up -d --build
```

Open the Web UI:

```text
http://127.0.0.1:6446/app
```

Use the `ADMIN_PASSWORD` from `.env.docker` to unlock the admin console.

## Persistent Data

The Compose file stores JSON runtime configuration under `./data`:

```text
data/api-keys.json
data/models.json
data/settings.json
data/proxies.json
```

Redis stores limiter counters in the named volume `redis-data`.

Back up `./data` before upgrades or host migration:

```bash
tar -czf opencode-proxy-hub-data.tgz data
```

## Health Checks

App health:

```bash
curl http://127.0.0.1:6446/health
```

Compose health status:

```bash
docker compose ps
```

Logs:

```bash
docker compose logs -f app
```

## Smoke Tests Against Docker

Run protocol and local load smoke tests from the host after the stack is up:

```bash
npm run smoke:protocol
npm run smoke:load
```

Run the admin stability check with the same admin token:

```bash
ADMIN_PASSWORD=your-password npm run check:stability
```

On Windows PowerShell:

```powershell
$env:ADMIN_PASSWORD = "your-password"
npm run check:stability
```

## Reverse Proxy

Place Nginx, Caddy, or another HTTPS reverse proxy in front of `http://127.0.0.1:6446` for public deployment.

Minimum proxy requirements:

- preserve `Authorization` and `x-api-key` headers
- support long-lived streaming responses
- disable response buffering for SSE paths if possible
- forward client disconnects promptly

## Outbound Proxy Mode and Pre-Proxy

Proxy mode controls whether requests use the proxy pool:

```text
PROXY_MODE=optional
```

Supported values:

- `direct`: never use the proxy pool
- `optional`: use the first available proxy-pool node, otherwise fall back to direct upstream access
- `required`: require a proxy-pool node; fail the request when no node is available

`REQUIRE_PROXY=true` is kept as a legacy fallback when `PROXY_MODE` is not set, and is equivalent to `PROXY_MODE=required`.

If the Docker container cannot directly reach a proxy provider, enable the outbound pre-proxy chain:

```text
OUTBOUND_PRE_PROXY_ENABLED=true
OUTBOUND_PRE_PROXY_URL=http://host.docker.internal:7897
```

Use `host.docker.internal` when the pre-proxy runs on the Docker host. Use `127.0.0.1` only when running the Node app directly on the host.

The current MVP supports this chain:

```text
OpenCodeProxyHub -> HTTP/HTTPS pre-proxy -> proxy-pool node -> opencode.ai
```

Proxy-pool node types supported in chained mode: `http`, `https`, and `socks5`.

If `OUTBOUND_PRE_PROXY_ENABLED=false`, proxy-pool nodes use the original direct single-proxy behavior.

Proxy selection uses priority fill. The first available enabled node is used until it is unavailable, full, daily-limited, or disabled. A node is automatically disabled after 5 consecutive upstream 429 responses and requires manual re-enable. Use `PROXY_MODE=required` when requests must never fall back to direct upstream access.

Proxy connection establishment has a separate timeout from the upstream request timeout:

```text
PROXY_CONNECT_TIMEOUT_MS=5000
```

It covers the proxy TCP connection, HTTP `CONNECT` or SOCKS5 negotiation, proxy authentication, and the target TLS handshake. When it expires, the node enters the normal 5-minute cooldown and the request switches to another untried proxy. It does not limit model generation or an established response stream. The value can also be changed at runtime as `proxyConnectTimeoutMs` in the Web console or `PATCH /admin/settings`.

`MAX_PROXY_ATTEMPTS` controls how many distinct proxy nodes one request may try. It defaults to `3`, accepts positive integers from `1` through `50`, and is configured at process startup. Higher values increase worst-case request latency and upstream load. When raising it, also design an overall retry time budget so that as many as 50 sequential timeouts cannot accumulate without a bound.

The proxy console also supports:

- checking every configured proxy through a bounded worker queue (at most 10 concurrent checks) against Cloudflare's `https://cp.cloudflare.com/generate_204` connectivity endpoint and deleting nodes that cannot access the public internet
- manually synchronizing 100 unique HTTP proxies from SCDN
- enabling scheduled SCDN synchronization with a configurable interval

The SCDN endpoint returns at most 20 proxies per request, so one synchronization uses multiple batches and updates the SCDN-managed set only after collecting 100 unique addresses. After every manual or scheduled synchronization, all nodes in the proxy pool are queued for connectivity checks and unreachable nodes are automatically deleted. Manually managed proxies are preserved during source replacement, but are included in the post-sync connectivity check.

## Upgrade

```bash
docker compose pull
docker compose up -d --build
docker compose logs -f app
```

For local source deployments, `docker compose up -d --build` rebuilds the app image from the current checkout.

## Security Notes

- Always change `ADMIN_PASSWORD` in `.env.docker` for any shared or public environment.
- Keep `.env.docker` out of Git.
- Back up `./data`.
- Docker Compose enables `STORE_PLAINTEXT_API_KEYS=true` for operator convenience, so newly created API keys can be copied later from the Web UI.
- When `STORE_PLAINTEXT_API_KEYS=true`, complete API keys are stored in `data/api-keys.json`; protect this file like a secret.
- Existing keys created before plaintext recovery was enabled cannot be recovered; recreate them if needed.
- Rotate API keys from the Web UI if a key is exposed.
