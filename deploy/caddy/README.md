# Production front end (Caddy)

One HTTPS origin serves the web app, the API and the published model files (WP 3.7). Caddy 2.10 (Apache-2.0) is a single binary with no dependencies, so it installs offline.

## What it does

- **TLS 1.2 and 1.3 only**, with the organisation's certificate and key. There is no automatic certificate request (no ACME) and no internet access. Plain HTTP redirects to HTTPS.
- **`/api/*`** goes to the Node server.
  - Upload bodies stream through unbuffered, and a single request can be up to 2 GB (a tus PATCH).
  - Caddy passes on the real client address, and ignores an `X-Forwarded-For` header sent by the client, so the audit log records the right IP.
- **`/files/*`** is served straight from `STORAGE_DIR/files`.
  - Each response carries an ETag and Last-Modified, and answers range requests.
  - Files are cached for a year as immutable.
  - JSON and glTF are compressed with zstd or gzip.
  - Paths never change. A re-rendered thumbnail gets a new file name, so a new classification band is never hidden by a cache.
- **Everything else** is the web app.
  - The hashed assets under `/assets/` are immutable.
  - `index.html` is checked on every load, so an update reaches everyone at once.
  - It also adds HSTS, `nosniff`, `no-referrer` and `DENY` framing.

## Run it

```sh
export VIEWER_HOST=viewer.internal
export TLS_CERT=/etc/viewer/tls/viewer-chain.pem TLS_KEY=/etc/viewer/tls/viewer.key
export WEB_ROOT=/opt/viewer/web FILES_ROOT=/var/lib/viewer/storage/files
caddy run --config /opt/viewer/deploy/caddy/Caddyfile --adapter caddyfile
```

The other settings and their defaults:

| Variable | Default |
|---|---|
| `API_UPSTREAM` | `127.0.0.1:8787` |
| `HTTP_PORT` | `80` |
| `HTTPS_PORT` | `443` |
| `LOG_DIR` | `/var/log/viewer` |

Keep the Node server on `127.0.0.1`, which is its default. It trusts forwarded addresses, so it must only be reachable through Caddy.

## Load test (NFR-05)

`scripts/load-20-users.cjs https://viewer.internal ca.pem` first publishes a 200 MB GLB through the real upload path. It then runs 20 simulated users, and each user:

1. opens the app page and the library, then the model, which is audited;
2. downloads the whole GLB;
3. makes 30 range reads of 512 KB each;
4. re-checks the GLB against the cache, expecting a 304 answer.

It runs this twice:

- **Burst:** all 20 users start at the same instant. That is 4 GB at once, so the result is limited by the network.
- **Working session:** each user starts at a random moment within 60 seconds (change this with `SPREAD_S`).

The test passes when there are no errors and every user in the working session gets the GLB within the NFR-01 budget of 5 seconds.

### Results on the build sandbox

These numbers come from one 4-core machine with a test certificate, where Caddy, Node and all 20 clients share the CPU:

- **One user:** 200 MB in 0.65 s.
- **Burst:** every user had the GLB within 7.6 s. That is 4.4 Gbit/s in total, limited by TLS encryption and decryption on the shared cores. On a 1 Gbit/s network the same 4 GB takes at least 34 s.
- **Working session:** the slowest user had the GLB in 0.55 s, and there were no errors in either run.
