import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchDownloads, retryDownload } from '../../src/api/downloads';

describe('api/downloads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty list when account hashes are empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(fetchDownloads([])).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps the legacy null downloads response to an empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('null', { status: 200 }),
    );

    await expect(fetchDownloads(['abcdef12'])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/downloads?accountHashes=abcdef12',
      { headers: {} },
    );
  });

  it('throws when the downloads response shape is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"id":"bad"}', { status: 200 }),
    );

    await expect(fetchDownloads(['abcdef12'])).rejects.toThrow(
      'Invalid downloads response',
    );
  });

  it('returns a failed task to its device queue', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200 }),
    );

    await retryDownload('task-1', 'abcdef12');

    expect(fetch).toHaveBeenCalledWith(
      '/api/downloads/task-1/retry?accountHash=abcdef12',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
