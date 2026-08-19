import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepare = path.join(root, "scripts", "prepare-applepackage-dependency.sh");
const source = path.join(root, "backend-swift", ".build", "checkouts", "ApplePackage");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-applepackage-"));
  const checkout = path.join(directory, "backend", ".build", "checkouts", "ApplePackage");
  fs.mkdirSync(checkout, { recursive: true });
  const archive = spawnSync("git", ["-C", source, "archive", "1.2.7"], { encoding: null });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  const extract = spawnSync("tar", ["-x", "-C", checkout], { input: archive.stdout });
  assert.equal(extract.status, 0, extract.stderr?.toString());
  return { directory, backend: path.join(directory, "backend"), checkout };
}

function run(entry, minIOS) {
  return spawnSync("bash", [
    prepare,
    "--backend-dir", entry.backend,
    "--min-ios", minIOS,
    "--no-resolve",
  ], { cwd: root, encoding: "utf8" });
}

test("applies runtime fixes to every profile without lowering iOS 15", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const result = run(entry, "15.0");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Applied ApplePackage runtime fixes/);
  const manifest = fs.readFileSync(path.join(entry.checkout, "Package.swift"), "utf8");
  const auth = fs.readFileSync(path.join(entry.checkout, "Sources/ApplePackage/Commands/Authenticate.swift"), "utf8");
  assert.match(manifest, /\.iOS\(\.v15\)/);
  assert.match(auth, /legacyAuthEndpoint/);
});

test("also lowers the package declaration for the iOS 14 profile and is idempotent", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));

  const first = run(entry, "14.0");
  const second = run(entry, "14.0");

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /runtime fixes already applied/);
  assert.match(second.stdout, /iOS 14 compatibility patch already applied/);
  const manifest = fs.readFileSync(path.join(entry.checkout, "Package.swift"), "utf8");
  assert.match(manifest, /\.iOS\(\.v14\)/);
  assert.doesNotMatch(manifest, /\.iOS\(\.v15\)/);
});

test("fails closed when the dependency source no longer matches the pinned patch", (t) => {
  const entry = fixture();
  t.after(() => fs.rmSync(entry.directory, { recursive: true, force: true }));
  const authPath = path.join(entry.checkout, "Sources/ApplePackage/Commands/Authenticate.swift");
  const auth = fs.readFileSync(authPath, "utf8");
  fs.writeFileSync(authPath, auth.replace("public enum Authenticator {", "public enum Authenticator { // changed upstream"));

  const result = run(entry, "15.0");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime fixes no longer applies cleanly/);
});
