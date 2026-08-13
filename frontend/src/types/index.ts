export interface Software {
  id: number;
  rank?: number;
  bundleID: string;
  name: string;
  version: string;
  price?: number;
  artistName: string;
  sellerName: string;
  description: string;
  averageUserRating: number;
  userRatingCount: number;
  artworkUrl: string;
  screenshotUrls: string[];
  minimumOsVersion: string;
  fileSizeBytes?: string;
  releaseDate: string;
  releaseNotes?: string;
  formattedPrice?: string;
  primaryGenreName: string;
}

export interface Cookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  expiresAt?: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface Account {
  email: string;
  password: string;
  appleId: string;
  store: string;
  firstName: string;
  lastName: string;
  passwordToken: string;
  directoryServicesIdentifier: string;
  cookies: Cookie[];
  deviceIdentifier: string;
  pod?: string;
}

export interface Sinf {
  id: number;
  sinf: string; // base64
}

export interface DownloadOutput {
  downloadURL: string;
  sinfs: Sinf[];
  bundleShortVersionString: string;
  bundleVersion: string;
  iTunesMetadata?: string;
}

export interface VersionMetadata {
  displayVersion: string;
  releaseDate: string;
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  status:
    | "pending"
    | "downloading"
    | "paused"
    | "injecting"
    | "decrypting"
    | "completed"
    | "failed";
  progress: number;
  speed: string;
  error?: string;
  errorCode?:
    | "encrypted_mapping_denied"
    | "fairplay_authorization"
    | "memory_pressure"
    | "invalid_signature"
    | "device_locked"
    | "bundle_busy"
    | "verification_failed"
    | "insufficient_storage"
    | "unknown";
  logs?: string[];
  decryptEvents?: DecryptEvent[];
  forceExtensionDecryption?: boolean;
  hasFile?: boolean;
  verification?: {
    scannedMachOCount: number;
    verifiedMachOCount: number;
  };
  sha256?: string;
  queuePosition?: number;
  canRetry?: boolean;
  extensionDecryptionPolicy?: "main_only" | "compatible" | "strict";
  decryptCheckpoint?: {
    phase: "queued" | "preparing" | "scanning" | "decrypting" | "packaging" | "verifying" | "completed";
    schemaVersion?: number;
    inputSize?: number;
    attempt: number;
    batchSize: number;
    completedMachOCount: number;
    totalMachOCount?: number;
    currentPath?: string;
    updatedAt: string;
  };
  createdAt: string;
}

export interface DecryptEvent {
  kind: "main" | "framework" | "extension" | "report" | string;
  status: "decrypted" | "skipped" | "info" | "warning" | "failed" | string;
 path?: string;
  reportTotal?: number;
  reportDecrypted?: number;
  reportRemaining?: number;
  reportMainRemaining?: number;
  reportFrameworkRemaining?: number;
  reportExtensionRemaining?: number;
 message: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  fileSize: number;
  createdAt: string;
}
