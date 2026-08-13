import { apiGet, apiPost, ApiError } from './client';
import { accountHash } from '../utils/account';
import type {
  Account,
  Cookie,
  DownloadTask,
  Software,
  VersionMetadata,
} from '../types';

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

interface AccountResponse {
  account: Account;
}

interface VersionListResponse {
  account: Account;
  versions: string[];
}

interface VersionMetadataResponse {
  account: Account;
  metadata: VersionMetadata;
}

export interface HistoricalVersionRecord {
  versionId: string;
  version: string;
  date?: string;
  sizeText?: string;
  source: string;
}

export interface HistoricalVersionListResponse {
  provider: string;
  records: HistoricalVersionRecord[];
  versions: string[];
  errors: string[];
  cached?: boolean;
}

interface AppleDownloadResponse {
  account: Account;
  task: DownloadTask;
}

export interface DefaultAccountStatus {
  configured: boolean;
  emailMasked?: string;
  store?: string;
  pod?: string;
  accountHash?: string;
  updatedAt?: string;
}

interface DefaultAppleDownloadResponse {
  task: DownloadTask;
  accountHash: string;
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceIdentifier: string = '',
): Promise<Account> {
  try {
    const response = await apiPost<AccountResponse>('/api/apple/authenticate', {
      email,
      password,
      code,
      existingCookies,
      deviceIdentifier,
    });
    return response.account;
  } catch (error) {
    if (error instanceof ApiError && error.codeRequired) {
      throw new AuthenticationError(error.message, true);
    }
    throw error;
  }
}

export async function purchaseApp(
  account: Account,
  software: Software,
): Promise<Account> {
  const response = await apiPost<AccountResponse>('/api/apple/purchase', {
    account,
    software,
  });
  return response.account;
}

export async function listVersions(
  account: Account,
  software: Software,
): Promise<VersionListResponse> {
  return apiPost<VersionListResponse>('/api/apple/versions', {
    account,
    software,
  });
}

export async function listHistoricalVersions(
  software: Software,
  provider: string = 'auto',
): Promise<HistoricalVersionListResponse> {
  return apiPost<HistoricalVersionListResponse>('/api/apple/historical-versions', {
    software,
    provider,
  });
}

export async function getVersionMetadata(
  account: Account,
  software: Software,
  versionId: string,
): Promise<VersionMetadataResponse> {
  return apiPost<VersionMetadataResponse>('/api/apple/version-metadata', {
    account,
    software,
    versionId,
  });
}

export async function startAppleDownload(
  account: Account,
  software: Software,
  externalVersionId?: string,
  forceExtensionDecryption?: boolean,
): Promise<AppleDownloadResponse> {
  const response = await apiPost<AppleDownloadResponse>('/api/downloads/apple', {
    account,
    software,
    accountHash: await accountHash(account),
    externalVersionId,
    forceExtensionDecryption,
  });
  return response;
}

export async function getDefaultAccountStatus(): Promise<DefaultAccountStatus> {
  return apiGet<DefaultAccountStatus>('/api/account/default/status');
}

export async function startDefaultAppleDownload(
  software: Software,
  externalVersionId?: string,
  forceExtensionDecryption?: boolean,
): Promise<DefaultAppleDownloadResponse> {
  return apiPost<DefaultAppleDownloadResponse>('/api/downloads/apple/default', {
    software,
    externalVersionId,
    forceExtensionDecryption,
  });
}
