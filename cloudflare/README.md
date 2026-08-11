# Cloudflare Deploy (Workers + Containers)

This folder contains the Worker source used by the root `wrangler.jsonc`.

## Why Containers

AssppWeb backend needs:

- WebSocket upgrades (`/wisp/`)
- filesystem writes for compiled IPA output
- long-running Node.js runtime behavior

Cloudflare Containers runs the existing Dockerized app with minimal changes.

## Deploy

```bash
npx wrangler login
npx wrangler deploy
```

For local preview on Cloudflare runtime:

```bash
npx wrangler dev
```

## Notes

- Deploy configuration lives in the repository root `wrangler.jsonc`.
- `cloudflare/src/index.ts` imports `@cloudflare/containers`.
- Root `wrangler.jsonc` runs a build command to install `@cloudflare/containers` automatically before deploy, so CI can still run plain `npx wrangler deploy`.
- The worker routes all HTTP and WebSocket traffic to one named container instance (`main`) to keep app state consistent.
- Container filesystem is ephemeral. Compiled packages may be lost when the container stops and restarts.

## Troubleshooting

If deploy logs fail after upload with:

```text
Deploy a container application
Unauthorized
```

the account/token used by CI is missing required permissions for Containers APIs.

Required account token permissions:

- `Workers Scripts Edit`
- `Containers Edit`
- `Cloudchamber Edit`

Also ensure the account is on a Workers Paid plan, since Containers are not available on Free.
