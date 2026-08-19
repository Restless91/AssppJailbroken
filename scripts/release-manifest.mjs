#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedProfiles = ["iphone8", "iphone11", "iphone15"];
const requiredProfileFields = [
  "profile",
  "deviceArchitecture",
  "debArchitecture",
  "machOArch",
  "swiftTarget",
  "minIOS",
  "provider",
  "extensionPolicy",
  "batchSize",
  "jetsamMB",
  "compatibilityPatches",
  "runtimeAssets",
];

function readManifest(repositoryRoot) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, "release", "manifest.json"), "utf8"));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseVersion(value, name) {
  invariant(typeof value === "string" && /^\d+\.\d+$/.test(value), `${name} must use major.minor format`);
  return value.split(".").map(Number);
}

function versionLessThan(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function verifyChecksummedFile(repositoryRoot, evidence, label) {
  invariant(evidence && typeof evidence === "object" && !Array.isArray(evidence), `${label} must be an object`);
  invariant(typeof evidence.path === "string" && evidence.path.length > 0 && !path.isAbsolute(evidence.path), `${label}.path must be relative`);
  invariant(!evidence.path.split(/[\\/]/).includes(".."), `${label}.path may not leave the repository`);
  invariant(/^[0-9a-f]{64}$/.test(evidence.sha256), `${label}.sha256 is invalid`);
  const absolutePath = path.join(repositoryRoot, evidence.path);
  invariant(fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile(), `${label} missing: ${evidence.path}`);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  invariant(digest === evidence.sha256, `${label} checksum mismatch: ${evidence.path}`);
}

function validateManifest(manifest, repositoryRoot) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "manifest must be an object");
  invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
  invariant(/^\d+\.\d+\.\d+$/.test(manifest.version), "version must use x.y.z format");
  invariant(manifest.dependencies && typeof manifest.dependencies === "object", "dependencies must be an object");
  invariant(manifest.dependencies.unfair?.repository === "lbr77/unfair", "dependencies.unfair.repository is invalid");
  invariant(/^[0-9a-f]{40}$/.test(manifest.dependencies.unfair?.ref), "dependencies.unfair.ref must be a full commit SHA");
  parseVersion(manifest.dependencies.unfair?.minIOS, "dependencies.unfair.minIOS");
  invariant(manifest.dependencies.applePackage?.repository === "Lakr233/ApplePackage", "dependencies.applePackage.repository is invalid");
  invariant(/^\d+\.\d+\.\d+$/.test(manifest.dependencies.applePackage?.exactVersion), "dependencies.applePackage.exactVersion is invalid");
  parseVersion(manifest.dependencies.applePackage?.minIOS, "dependencies.applePackage.minIOS");
  invariant(manifest.dependencies.applePackage?.patchStrategy === "profile-compatibility-patch", "dependencies.applePackage.patchStrategy is invalid");
  invariant(Array.isArray(manifest.dependencies.applePackage?.sourcePatches) && manifest.dependencies.applePackage.sourcePatches.length > 0, "dependencies.applePackage.sourcePatches must not be empty");
  const sourcePatchIDs = new Set();
  for (const patch of manifest.dependencies.applePackage.sourcePatches) {
    invariant(patch && typeof patch === "object" && !Array.isArray(patch), "ApplePackage source patch must be an object");
    invariant(/^[A-Za-z][A-Za-z0-9]*$/.test(patch.id), `ApplePackage source patch ID is invalid: ${patch.id}`);
    invariant(!sourcePatchIDs.has(patch.id), `duplicate ApplePackage source patch: ${patch.id}`);
    sourcePatchIDs.add(patch.id);
    invariant(patch.strategy === "build-time-source-patch", `${patch.id}.strategy must be build-time-source-patch`);
    invariant(Array.isArray(patch.profiles), `${patch.id}.profiles must be an array`);
    invariant(
      patch.profiles.length === expectedProfiles.length && expectedProfiles.every((profile) => patch.profiles.includes(profile)),
      `${patch.id} must cover every release profile`,
    );
    invariant(new Set(patch.profiles).size === patch.profiles.length, `${patch.id}.profiles contains duplicates`);
    invariant(Array.isArray(patch.evidenceFiles) && patch.evidenceFiles.length >= 2, `${patch.id}.evidenceFiles must include a script and patch`);
    invariant(patch.evidenceFiles.some((file) => /\.(?:sh|mjs)$/.test(file.path)), `${patch.id}.evidenceFiles requires a preparation script`);
    invariant(patch.evidenceFiles.some((file) => /\.(?:patch|diff)$/.test(file.path)), `${patch.id}.evidenceFiles requires a patch file`);
    for (const evidence of patch.evidenceFiles) {
      verifyChecksummedFile(repositoryRoot, evidence, `${patch.id} source patch evidence`);
    }
  }
  invariant(manifest.profiles && typeof manifest.profiles === "object", "profiles must be an object");
  invariant(manifest.compatibilityPatches && typeof manifest.compatibilityPatches === "object" && !Array.isArray(manifest.compatibilityPatches), "compatibilityPatches must be an object");

  for (const [patchID, patch] of Object.entries(manifest.compatibilityPatches)) {
    invariant(/^[A-Za-z][A-Za-z0-9]*$/.test(patchID), `compatibility patch ID is invalid: ${patchID}`);
    invariant(patch && typeof patch === "object" && !Array.isArray(patch), `${patchID} must be an object`);
    invariant(Object.hasOwn(manifest.dependencies, patch.dependency), `${patchID}.dependency is unknown: ${patch.dependency}`);
    invariant(Array.isArray(patch.profiles) && patch.profiles.length > 0, `${patchID}.profiles must not be empty`);
    invariant(patch.profiles.every((profile) => expectedProfiles.includes(profile)), `${patchID}.profiles contains an unknown profile`);
    invariant(new Set(patch.profiles).size === patch.profiles.length, `${patchID}.profiles contains duplicates`);
    invariant(patch.strategy === "build-time-source-patch", `${patchID}.strategy must be build-time-source-patch`);
    invariant(Array.isArray(patch.evidenceFiles) && patch.evidenceFiles.length >= 2, `${patchID}.evidenceFiles must include a script and patch`);
    invariant(patch.evidenceFiles.some((file) => /\.(?:sh|mjs)$/.test(file.path)), `${patchID}.evidenceFiles requires a preparation script`);
    invariant(patch.evidenceFiles.some((file) => /\.(?:patch|diff)$/.test(file.path)), `${patchID}.evidenceFiles requires a patch file`);
    for (const evidence of patch.evidenceFiles) {
      verifyChecksummedFile(repositoryRoot, evidence, `${patchID} evidence`);
    }
  }

  const profileNames = Object.keys(manifest.profiles);
  invariant(
    profileNames.length === expectedProfiles.length && expectedProfiles.every((name) => Object.hasOwn(manifest.profiles, name)),
    `profiles must be exactly: ${expectedProfiles.join(", ")}`,
  );

  for (const profileName of expectedProfiles) {
    const profile = manifest.profiles[profileName];
    invariant(profile && typeof profile === "object" && !Array.isArray(profile), `${profileName} must be an object`);
    for (const field of requiredProfileFields) {
      invariant(Object.hasOwn(profile, field), `${profileName}.${field} is required`);
    }

    invariant(["rootless", "taurine"].includes(profile.profile), `${profileName}.profile is unsupported`);
    invariant(["arm64", "arm64e"].includes(profile.deviceArchitecture), `${profileName}.deviceArchitecture is unsupported`);
    invariant(["iphoneos-arm", "iphoneos-arm64"].includes(profile.debArchitecture), `${profileName}.debArchitecture is unsupported`);
    invariant(["arm64", "arm64e"].includes(profile.machOArch), `${profileName}.machOArch is unsupported`);
    invariant(/^\d+\.\d+$/.test(profile.minIOS), `${profileName}.minIOS must use major.minor format`);
    invariant(["builtin", "fouldecrypt.kernrw"].includes(profile.provider), `${profileName}.provider is unsupported`);
    invariant(
      ["main-only", "compatible", "strict"].includes(profile.extensionPolicy),
      `${profileName}.extensionPolicy is unsupported`,
    );
    invariant(Number.isInteger(profile.batchSize) && profile.batchSize > 0, `${profileName}.batchSize must be a positive integer`);
    invariant(Number.isInteger(profile.jetsamMB) && profile.jetsamMB >= 128, `${profileName}.jetsamMB must be at least 128`);
    invariant(Array.isArray(profile.compatibilityPatches), `${profileName}.compatibilityPatches must be an array`);
    invariant(new Set(profile.compatibilityPatches).size === profile.compatibilityPatches.length, `${profileName}.compatibilityPatches contains duplicates`);
    invariant(Array.isArray(profile.runtimeAssets), `${profileName}.runtimeAssets must be an array`);

    const targetMatch = /^(arm64|arm64e)-apple-ios(\d+\.\d+)$/.exec(profile.swiftTarget);
    invariant(targetMatch, `${profileName}.swiftTarget is invalid`);
    invariant(targetMatch[1] === profile.machOArch, `${profileName}.swiftTarget must match machOArch`);
    invariant(targetMatch[2] === profile.minIOS, `${profileName}.swiftTarget must match minIOS`);

    if (profile.profile === "taurine") {
      invariant(profile.debArchitecture === "iphoneos-arm", `${profileName} Taurine profile requires iphoneos-arm`);
      invariant(profile.provider === "fouldecrypt.kernrw", `${profileName} Taurine profile requires fouldecrypt.kernrw`);
      invariant(profile.runtimeAssets.length > 0, `${profileName} Taurine profile requires runtimeAssets`);
    } else {
      invariant(profile.debArchitecture === "iphoneos-arm64", `${profileName} rootless profile requires iphoneos-arm64`);
    }

    for (const patchID of profile.compatibilityPatches) {
      const patch = manifest.compatibilityPatches[patchID];
      invariant(patch, `${profileName} references unknown compatibility patch: ${patchID}`);
      invariant(patch.profiles.includes(profileName), `${patchID} does not cover profile ${profileName}`);
    }

    const profileMinIOS = parseVersion(profile.minIOS, `${profileName}.minIOS`);
    for (const [dependencyName, dependency] of Object.entries(manifest.dependencies)) {
      const dependencyMinIOS = parseVersion(dependency.minIOS, `dependencies.${dependencyName}.minIOS`);
      if (!versionLessThan(profileMinIOS, dependencyMinIOS)) continue;
      const coversDependency = profile.compatibilityPatches.some((patchID) => {
        const patch = manifest.compatibilityPatches[patchID];
        return patch?.dependency === dependencyName && patch.profiles.includes(profileName);
      });
      invariant(coversDependency, `${profileName} requires a compatibility patch for ${dependencyName}`);
    }

    for (const asset of profile.runtimeAssets) {
      invariant(asset && typeof asset === "object" && !Array.isArray(asset), `${profileName}.runtimeAssets entries must be objects`);
      invariant(typeof asset.path === "string" && asset.path.length > 0 && !path.isAbsolute(asset.path), `${profileName}.runtimeAssets paths must be relative`);
      invariant(!asset.path.split(/[\\/]/).includes(".."), `${profileName}.runtimeAssets may not leave the repository`);
      invariant(/^[0-9a-f]{64}$/.test(asset.sha256), `${profileName} runtime asset sha256 is invalid: ${asset.path}`);
      verifyChecksummedFile(repositoryRoot, asset, `${profileName} runtime asset`);
    }
  }

  invariant(manifest.profiles.iphone15.deviceArchitecture === "arm64e", "iphone15 deviceArchitecture must be arm64e");
  invariant(manifest.profiles.iphone15.machOArch === "arm64", "iphone15 daemon machOArch must remain arm64-compatible");
}

function parseControl(contents, file) {
  const fields = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim());
  }
  invariant(fields.has("Version"), `${file} has no Version field`);
  invariant(fields.has("Architecture"), `${file} has no Architecture field`);
  return fields;
}

function readText(repositoryRoot, relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  invariant(fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile(), `generated file missing: ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function checkGenerated(manifest, repositoryRoot) {
  const controlFiles = [
    ["backend-swift/control", manifest.profiles.iphone15.debArchitecture],
    ...expectedProfiles.map((variant) => [
      `backend-swift/packaging/control.${variant}`,
      manifest.profiles[variant].debArchitecture,
    ]),
  ];

  for (const [relativePath, expectedArchitecture] of controlFiles) {
    const fields = parseControl(readText(repositoryRoot, relativePath), relativePath);
    invariant(fields.get("Version") === manifest.version, `${relativePath} Version must be ${manifest.version}`);
    invariant(fields.get("Architecture") === expectedArchitecture, `${relativePath} Architecture must be ${expectedArchitecture}`);
  }

  const readme = readText(repositoryRoot, "README.md");
  invariant(readme.includes(`**v${manifest.version}**`), `README.md current version must be v${manifest.version}`);
  for (const variant of expectedProfiles) {
    const profile = manifest.profiles[variant];
    const filename = `wiki.qaq.unfaird_${manifest.version}_${variant}_${profile.debArchitecture}.deb`;
    invariant(readme.includes(filename), `README.md must reference ${filename}`);
  }

  const platformPackage = JSON.parse(readText(repositoryRoot, "private-platform/package.json"));
  invariant(platformPackage.version === manifest.version, `private-platform/package.json version must be ${manifest.version}`);
}

function parseRepositoryRoot(args) {
  const rootIndex = args.indexOf("--root");
  if (rootIndex === -1) return defaultRoot;
  invariant(args[rootIndex + 1], "--root requires a path");
  invariant(rootIndex + 2 === args.length, "unexpected arguments after --root");
  return path.resolve(args[rootIndex + 1]);
}

function findRuntimeAsset(profile, basename) {
  return profile.runtimeAssets.find((asset) => path.basename(asset.path) === basename)?.path ?? "";
}

function buildMatrix(manifest) {
  return {
    include: expectedProfiles.map((variant) => {
      const profile = manifest.profiles[variant];
      return {
        variant,
        profile: profile.profile,
        deb_arch: profile.debArchitecture,
        device_arch: profile.deviceArchitecture,
        mach_o_arch: profile.machOArch,
        swift_target: profile.swiftTarget,
        min_ios: profile.minIOS,
        runtime_runner: findRuntimeAsset(profile, "UnfairRuntimeRunner"),
        runtime_dumper: findRuntimeAsset(profile, "UnfairRuntimeDumper.dylib"),
      };
    }),
  };
}

function assertToken(value, name) {
  const token = String(value);
  invariant(token.length > 0 && !/\s|['"`$\\]/.test(token), `${name} is unsafe for shell output`);
  return token;
}

function buildEnvironment(manifest, variant) {
  const profile = manifest.profiles[variant];
  invariant(profile, `unknown profile: ${variant ?? "(missing)"}`);
  const variables = {
    RELEASE_VERSION: manifest.version,
    DEVICE_VARIANT: variant,
    DEVICE_PROFILE: profile.profile,
    DEVICE_ARCHITECTURE: profile.deviceArchitecture,
    DEB_ARCHITECTURE: profile.debArchitecture,
    MACH_O_ARCH: profile.machOArch,
    SWIFT_TARGET: profile.swiftTarget,
    IOS_TARGET: profile.swiftTarget,
    MIN_IOS: profile.minIOS,
    PROVIDER: profile.provider,
    EXTENSION_POLICY: profile.extensionPolicy,
    BATCH_SIZE: profile.batchSize,
    JETSAM_MB: profile.jetsamMB,
  };

  return Object.entries(variables)
    .map(([name, value]) => `${name}=${assertToken(value, name)}`)
    .join(" ");
}

function main() {
  const args = process.argv.slice(2);
  const [command, argument] = args;
  const repositoryRoot = parseRepositoryRoot(args);
  const manifest = readManifest(repositoryRoot);

  if (command === "validate") {
    validateManifest(manifest, repositoryRoot);
    checkGenerated(manifest, repositoryRoot);
    process.stdout.write(`release manifest valid (${expectedProfiles.length} profiles)\n`);
    return;
  }

  if (command === "version") {
    validateManifest(manifest, repositoryRoot);
    process.stdout.write(`${manifest.version}\n`);
    return;
  }

  if (command === "matrix") {
    validateManifest(manifest, repositoryRoot);
    process.stdout.write(`${JSON.stringify(buildMatrix(manifest))}\n`);
    return;
  }

  if (command === "env") {
    validateManifest(manifest, repositoryRoot);
    process.stdout.write(`${buildEnvironment(manifest, argument)}\n`);
    return;
  }

  if (command === "check-generated") {
    validateManifest(manifest, repositoryRoot);
    checkGenerated(manifest, repositoryRoot);
    process.stdout.write("generated release metadata is current\n");
    return;
  }

  throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`release manifest: ${error.message}\n`);
  process.exitCode = 1;
}
