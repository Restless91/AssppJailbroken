# Jailbroken iPhone Package

The production jailbroken iPhone package is built from `backend-swift/` as `wiki.qaq.unfaird`. It serves the built React frontend, exposes the `/api/*` surface used by the web app and local HTTP clients, runs Apple protocol requests on the Swift backend, downloads Apple CDN IPAs, injects SINF and metadata, decrypts the IPA locally through unfaird, and serves completed IPA files back to the frontend.

It intentionally does not install IPAs locally. The completed decrypted package remains in `DATA_DIR/packages`, and the frontend downloads it through `/api/packages/{id}/file`.

## Decryption Flow

The integrated Swift backend exposes the same API contract as `../unfairdaemon/unfair.sh`:

```text
POST /api/v1/decrypt multipart field ipa
GET queue.ready_url
GET queue.download_url
```

The AssppWeb download API calls this local decrypt path directly inside the same launchd service.

## Apple Protocol Flow

The frontend calls Swift API routes for Apple operations:

```text
POST /api/apple/authenticate
POST /api/apple/purchase
POST /api/apple/versions
POST /api/apple/version-metadata
POST /api/downloads/apple
```

`backend-swift` resolves the bag endpoint, authenticates with the per-account device identifier, records storefront and pod, merges Apple cookies, acquires licenses, resolves CDN download info, creates the download task, injects metadata, and runs local decryption.

## Build

Before every formal release, increment the `Version` field in
`backend-swift/control`. Never reuse a previously published version number.
The version becomes part of the deb filename, so releases can coexist in
`backend-swift/debs/`.

```bash
make build
make list-releases
```

`make build` creates one complete rootless deb containing:

- the Vite frontend from `frontend/dist`
- the Swift/Vapor backend binary
- Swift runtime libraries required by the iOS binary
- the launchd plist and maintainer scripts

Install the generated package on a jailbroken iPhone:

```bash
make install DEVICE_HOST=root@<device-host>
```

Install or roll back to a retained version without rebuilding it:

```bash
make install-version VERSION=0.1.2 DEVICE_HOST=root@<device-host>
```

`install-version` passes `--allow-downgrades` to APT, so an older retained deb
can replace a newer installed release. `make clean-package` only removes build
intermediates and deliberately preserves `backend-swift/debs/*.deb`. Release
packages should also be uploaded to the corresponding GitHub Release or other
durable package archive; local files alone are not a backup.

The same root install target accepts Theos device variables:

```bash
THEOS=/Users/libr/theos THEOS_DEVICE_IP=<device-host> make install
```

## Runtime Layout

```text
/var/jb/usr/share/assppweb/
  public/

/var/jb/usr/local/lib/unfaird/
  UnfairDaemon
  libswift*.dylib

/var/mobile/AssppWebData/
  packages/
  tasks.json
```

On Dopamine/rootless, the executable is staged by Theos under the package install prefix and signed with `ldid`.

## CI

`.github/workflows/deb.yml` builds the same rootless iOS package on GitHub Actions. The workflow runs on macOS, installs Theos, checks out the sibling `lbr77/unfair` dependency at `../unfair`, calls `make build`, inspects the generated package, and uploads `wiki.qaq.unfaird_*_iphoneos-arm64.deb` as a workflow artifact.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `./data` | Persistent download metadata and IPA cache |
| `PUBLIC_DIR` | `./public` | Built frontend assets |
| `PUBLIC_BASE_URL` | auto-detect | Absolute base URL for manifest generation |
| `DOWNLOAD_THREADS` | `8` | Parallel HTTP range download workers |
| `MAX_DOWNLOAD_MB` | `0` | Optional server-side size limit |
| `ACCESS_PASSWORD` | empty | Optional UI/API access password |
