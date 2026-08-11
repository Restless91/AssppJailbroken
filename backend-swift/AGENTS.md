# AGENTS.md

## Project

`unfaird` is a SwiftPM 5.4 Vapor daemon. It accepts IPA decrypt requests over HTTP, serves the AssppWeb API/static frontend, runs Apple protocol requests for the web UI, and runs the local UnfairKit runner through POSIX spawn.

## Build

```bash
swift build
```

Run locally:

```bash
swift build
swift run UnfairDaemon serve
```

iOS deb package from the AssppWeb repository root:

```bash
make build
```

## API

Apple account and download flow:

```bash
curl -sS -X POST http://127.0.0.1:8080/api/apple/authenticate \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"password","deviceIdentifier":"aabbccddeeff"}'
```

Apple protocol routes are:

```text
POST /api/apple/authenticate
POST /api/apple/purchase
POST /api/apple/versions
POST /api/apple/version-metadata
POST /api/downloads/apple
```

The Swift backend owns bag resolution, authentication, pod routing, cookie merging, license acquisition, download info retrieval, IPA download, SINF injection, and local decryption for the AssppWeb UI and local HTTP clients.

Decrypt an IPA:

```bash
curl -sS -F "ipa=@/path/to/app.ipa" \
  http://127.0.0.1:8080/api/v1/decrypt
```

Decrypt jobs always run with verbose UnfairKit logs enabled.

The submit response includes `queue.id`, `queue.status`, `queue.ready`, `queue.ready_url`, `queue.download_url`, and `queue.validate_until`.

Check readiness:

```bash
curl -sS http://127.0.0.1:8080/api/v1/decrypt/<job-id>/ready
```

The ready response includes the same `queue` object and terminal `exit` logs when available.

Download a successful output:

```bash
curl -L -o output.ipa http://127.0.0.1:8080/api/v1/decrypt/<job-id>/output
```

## Decrypt Runtime Invariants

These are fixed runtime contracts.

- The UnfairKit extraction directory must be `$TMPDIR/../X/unfair/{UDID}`.
- Resolve `$TMPDIR` dynamically at process runtime. Launchd can change it across daemon starts.
- Do not override, rewrite, or sandbox-remap `TMPDIR` for decrypt/package runs.
- Sandbox profiles must allow the existing `$TMPDIR` and `$TMPDIR/../X/unfair` paths instead of moving UnfairKit work elsewhere.
- Preserve mtime and chmod from the IPA entries during extraction and when replacing entries in the output IPA.
- Keep temporary `.sinf` copies metadata-preserving.

## Deploy

Use the scripts in `deploy/` for macOS install and service management.

Use root `make build` to create the complete iOS deb with frontend assets, backend binary, Swift runtime libraries, and launchd files. The launchd label is `wiki.qaq.unfaird`.

The iOS runtime requires jailbreak-provided `libjailbreak.dylib`. `UnfairSupport` loads `libjailbreak.dylib` to initialize jailbreak primitives, set root MAC label, and mark current process with platform binary csflags before staged app bundle decryption.

Keep tracked docs and agent notes free of private deployment details:

- Do not write real hostnames, LAN IPs, user accounts, passwords, machine names, live process IDs, or live service status into docs.
- Prefer placeholders such as `user@host`, `/path/to/app.ipa`, and `<job-id>` in examples.
- Keep README concise and operational. Avoid promotional language and public-facing deployment detail.
