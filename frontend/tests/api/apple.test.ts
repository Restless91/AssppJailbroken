import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  authenticate,
  AuthenticationError,
  listHistoricalVersions,
  listVersions,
  startAppleDownload,
} from '../../src/api/apple';
import type { Account, DownloadTask, Software } from '../../src/types';

const account: Account = {
  email: 'user@example.com',
  password: 'password',
  appleId: 'user@example.com',
  store: '143441',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token',
  directoryServicesIdentifier: '1234567890',
  cookies: [],
  deviceIdentifier: 'aabbccddeeff',
  pod: '25',
};

const software: Software = {
  id: 123,
  bundleID: 'com.example.app',
  name: 'Example',
  version: '1.0',
  artistName: 'Example Inc.',
  sellerName: 'Example Inc.',
  description: 'Example app',
  averageUserRating: 5,
  userRatingCount: 10,
  artworkUrl: '',
  screenshotUrls: [],
  minimumOsVersion: '15.0',
  releaseDate: '2026-01-01T00:00:00Z',
  primaryGenreName: 'Utilities',
};

const task: DownloadTask = {
  id: 'task-1',
  software,
  accountHash: 'hash',
  status: 'pending',
  progress: 0,
  speed: '',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('api/apple', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates through the Swift API route', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ account }), { status: 200 }),
    );

    await expect(
      authenticate('user@example.com', 'password', undefined, [], 'aabbccddeeff'),
    ).resolves.toEqual(account);

    expect(fetch).toHaveBeenCalledWith('/api/apple/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'password',
        code: undefined,
        existingCookies: [],
        deviceIdentifier: 'aabbccddeeff',
      }),
    });
  });

  it('maps codeRequired responses to AuthenticationError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Verification required',
          codeRequired: true,
        }),
        { status: 400 },
      ),
    );

    await expect(authenticate('user@example.com', 'password')).rejects.toEqual(
      new AuthenticationError('Verification required', true),
    );
  });

  it('returns updated account data when listing versions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ account, versions: ['3', '2', '1'] }), {
        status: 200,
      }),
    );

    await expect(listVersions(account, software)).resolves.toEqual({
      account,
      versions: ['3', '2', '1'],
    });
  });

  it('loads historical version records without exposing an Apple account', async () => {
    const history = {
      provider: 'timbrd',
      records: [{ versionId: '888', version: '8.0.75', source: 'timbrd' }],
      versions: ['888'],
      errors: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(history), { status: 200 }),
    );

    await expect(listHistoricalVersions(software, 'auto')).resolves.toEqual(history);
    expect(fetch).toHaveBeenCalledWith('/api/apple/historical-versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ software, provider: 'auto' }),
    });
  });

  it('creates Apple downloads on the Swift backend', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ account, task }), { status: 201 }),
    );

    await expect(
      startAppleDownload(account, software, '456'),
    ).resolves.toEqual({ account, task });

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      accountHash: string;
      externalVersionId: string;
    };
    expect(call[0]).toBe('/api/downloads/apple');
    expect(body.accountHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.externalVersionId).toBe('456');
  });
});
