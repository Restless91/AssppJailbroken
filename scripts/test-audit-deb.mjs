import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audit = path.join(root, "scripts", "audit-deb.sh");

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-audit-deb-"));
  const bin = path.join(directory, "bin");
  const payload = path.join(directory, "payload");
  const deb = path.join(directory, "package.deb");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(payload, "usr/local/lib/unfaird"), { recursive: true });
  fs.writeFileSync(path.join(payload, "usr/local/lib/unfaird/UnfairDaemon"), "daemon");
  if (options.taurineAssets) {
    fs.writeFileSync(path.join(payload, "usr/local/lib/unfaird/UnfairRuntimeRunner"), "runner");
    fs.writeFileSync(path.join(payload, "usr/local/lib/unfaird/UnfairRuntimeDumper.dylib"), "dumper");
  }
  fs.writeFileSync(deb, "fixture");

  const tool = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  tool("dpkg-deb", `
case "\${1:-}" in
  -f)
    case "\${3:-}" in
      Version) printf '%s\\n' "\${FAKE_VERSION:-0.1.16}" ;;
      Architecture) printf '%s\\n' "\${FAKE_DEB_ARCH:-iphoneos-arm64}" ;;
      *) exit 2 ;;
    esac ;;
  -x) cp -R "\${FAKE_PAYLOAD:?}"/. "$3" ;;
  --contents) find "\${FAKE_PAYLOAD:?}" -type f -print ;;
  *) exit 2 ;;
esac`);
  tool("lipo", `printf '%s\\n' "Non-fat file: $2 is architecture: \${FAKE_MACH_O_ARCH:-arm64}"`);
  tool("vtool", `printf 'Load command 0\\n      cmd LC_BUILD_VERSION\\n    minos %s\\n' "\${FAKE_MIN_IOS:-15.0}"`);
  tool("otool", "exit 1");

  return { directory, bin, payload, deb };
}

function run(entry, variant, extraEnv = {}) {
  return spawnSync("bash", [audit, "--variant", variant, entry.deb], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${entry.bin}:${process.env.PATH}`,
      DPKG_DEB: path.join(entry.bin, "dpkg-deb"),
      LIPO: path.join(entry.bin, "lipo"),
      VTOOL: path.join(entry.bin, "vtool"),
      OTOOL: path.join(entry.bin, "otool"),
      FAKE_PAYLOAD: entry.payload,
      ...extraEnv,
    },
  });
}

test("accepts an iPhone 15 package while distinguishing device arm64e from daemon arm64", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const result = run(entry, "iphone15");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /device architecture: arm64e/);
  assert.match(result.stdout, /UnfairDaemon Mach-O architecture: arm64/);
  assert.match(result.stdout, /DEB audit passed: iphone15 0\.1\.16/);
});

test("rejects a package whose Debian architecture disagrees with the profile", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const result = run(entry, "iphone11", { FAKE_DEB_ARCH: "iphoneos-arm64" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEB architecture mismatch: expected iphoneos-arm, got iphoneos-arm64/);
});

test("rejects an incorrect minimum iOS deployment target", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const result = run(entry, "iphone15", { FAKE_MIN_IOS: "16.0" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /minimum iOS mismatch: expected 15\.0, got 16\.0/);
});

test("requires the packaged runner and dumper for Taurine", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const result = run(entry, "iphone11", { FAKE_DEB_ARCH: "iphoneos-arm", FAKE_MIN_IOS: "14.0" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Taurine runtime asset missing: UnfairRuntimeRunner/);
});
