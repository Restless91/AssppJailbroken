import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "release-manifest.mjs");

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function makeRepositoryFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-release-manifest-"));
  const files = [
    "release/manifest.json",
    "README.md",
    "backend-swift/control",
    "backend-swift/packaging/control.iphone8",
    "backend-swift/packaging/control.iphone11",
    "backend-swift/packaging/control.iphone15",
    "private-platform/package.json",
    "scripts/prepare-applepackage-dependency.sh",
    "patches/applepackage-ios14.patch",
    "patches/applepackage-runtime-fixes.patch",
    "backend-swift/vendor/taurine/bootstrap/UnfairRuntimeRunner",
    "backend-swift/vendor/taurine/bootstrap/UnfairRuntimeDumper.dylib",
    "backend-swift/vendor/taurine/fouldecrypt.kernrw",
    "backend-swift/vendor/taurine/libkernrw.0.dylib",
  ];
  for (const relativePath of files) {
    const destination = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), destination);
  }
  return fixture;
}

function readFixtureManifest(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture, "release/manifest.json"), "utf8"));
}

function writeFixtureManifest(fixture, manifest) {
  fs.writeFileSync(path.join(fixture, "release/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("version prints the canonical release version", () => {
  const result = run("version");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "0.1.16\n");
  assert.equal(result.stderr, "");
});

test("validate accepts the repository release manifest", () => {
  const result = run("validate");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "release manifest valid (3 profiles)\n");
  assert.equal(result.stderr, "");
});

test("matrix emits all build profiles and Taurine runtime inputs", () => {
  const result = run("matrix");

  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout);
  assert.deepEqual(matrix.include.map((entry) => entry.variant), ["iphone8", "iphone11", "iphone15"]);
  assert.deepEqual(
    matrix.include.map((entry) => [entry.profile, entry.deb_arch]),
    [["rootless", "iphoneos-arm64"], ["taurine", "iphoneos-arm"], ["rootless", "iphoneos-arm64"]],
  );
  assert.equal(matrix.include[1].runtime_runner, "backend-swift/vendor/taurine/bootstrap/UnfairRuntimeRunner");
  assert.equal(matrix.include[1].runtime_dumper, "backend-swift/vendor/taurine/bootstrap/UnfairRuntimeDumper.dylib");
  assert.equal(matrix.include[0].runtime_runner, "");
});

test("env emits make-compatible variables and preserves iPhone 15 architecture distinction", () => {
  const result = run("env", "iphone15");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "RELEASE_VERSION=0.1.16 DEVICE_VARIANT=iphone15 DEVICE_PROFILE=rootless DEVICE_ARCHITECTURE=arm64e DEB_ARCHITECTURE=iphoneos-arm64 MACH_O_ARCH=arm64 SWIFT_TARGET=arm64-apple-ios15.0 IOS_TARGET=arm64-apple-ios15.0 MIN_IOS=15.0 PROVIDER=builtin EXTENSION_POLICY=compatible BATCH_SIZE=8 JETSAM_MB=512\n",
  );
  assert.doesNotMatch(result.stdout.trim(), /\s{2,}|['\"]/);
});

test("env rejects unknown profiles", () => {
  const result = run("env", "iphone99");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown profile: iphone99/);
});

test("check-generated verifies every checked-in version consumer", () => {
  const result = run("check-generated");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "generated release metadata is current\n");
  assert.equal(result.stderr, "");
});

test("validate rejects a modified Taurine runtime asset", (t) => {
  const fixture = makeRepositoryFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.appendFileSync(
    path.join(fixture, "backend-swift/vendor/taurine/fouldecrypt.kernrw"),
    "modified",
  );

  const result = run("validate", "--root", fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime asset checksum mismatch/);
});

test("validate rejects an iOS 14 profile without dependency compatibility patches", (t) => {
  const fixture = makeRepositoryFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const manifest = readFixtureManifest(fixture);
  manifest.dependencies.unfair.minIOS = "14.0";
  manifest.dependencies.applePackage = {
    repository: "Lakr233/ApplePackage",
    exactVersion: "1.2.7",
    minIOS: "15.0",
    patchStrategy: "profile-compatibility-patch",
    sourcePatches: readFixtureManifest(fixture).dependencies.applePackage.sourcePatches.map((patch) => ({
      ...patch,
      evidenceFiles: patch.evidenceFiles.map((evidence) => evidence.path.endsWith('prepare-applepackage-dependency.sh')
        ? { path: evidence.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture, evidence.path))).digest('hex') }
        : evidence)
    })),
  };
  manifest.compatibilityPatches = {};
  manifest.profiles.iphone11.compatibilityPatches = [];
  writeFixtureManifest(fixture, manifest);

  const result = run("validate", "--root", fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /iphone11 requires a compatibility patch for applePackage/);
});

test("validate accepts a checksummed build-time compatibility patch for an iOS 14 profile", (t) => {
  const fixture = makeRepositoryFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const scriptPath = "scripts/prepare-applepackage-dependency.sh";
  const patchPath = "patches/applepackage-ios14.patch";
  const evidence = [
    [scriptPath, "#!/bin/sh\npatch -p1 < patches/applepackage-ios14.patch\n"],
    [patchPath, "--- a/Package.swift\n+++ b/Package.swift\n"],
  ];
  for (const [relativePath, contents] of evidence) {
    const absolutePath = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }

  const manifest = readFixtureManifest(fixture);
  manifest.dependencies.unfair.minIOS = "14.0";
  manifest.dependencies.applePackage = {
    repository: "Lakr233/ApplePackage",
    exactVersion: "1.2.7",
    minIOS: "15.0",
    patchStrategy: "profile-compatibility-patch",
    sourcePatches: readFixtureManifest(fixture).dependencies.applePackage.sourcePatches.map((patch) => ({
      ...patch,
      evidenceFiles: patch.evidenceFiles.map((evidence) => evidence.path.endsWith('prepare-applepackage-dependency.sh')
        ? { path: evidence.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture, evidence.path))).digest('hex') }
        : evidence)
    })),
  };
  manifest.compatibilityPatches = {
    applePackageIOS14: {
      dependency: "applePackage",
      profiles: ["iphone11"],
      strategy: "build-time-source-patch",
      evidenceFiles: evidence.map(([relativePath, contents]) => ({
        path: relativePath,
        sha256: crypto.createHash("sha256").update(contents).digest("hex"),
      })),
    },
  };
  for (const profile of Object.values(manifest.profiles)) profile.compatibilityPatches = [];
  manifest.profiles.iphone11.compatibilityPatches = ["applePackageIOS14"];
  writeFixtureManifest(fixture, manifest);

  const result = run("validate", "--root", fixture);

  assert.equal(result.status, 0, result.stderr);
});

test("validate rejects an ApplePackage source patch that does not cover every profile", (t) => {
  const fixture = makeRepositoryFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const manifest = readFixtureManifest(fixture);
  manifest.dependencies.applePackage.sourcePatches[0].profiles = ["iphone8", "iphone11"];
  writeFixtureManifest(fixture, manifest);

  const result = run("validate", "--root", fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must cover every release profile/);
});
