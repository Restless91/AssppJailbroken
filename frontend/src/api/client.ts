import { getAccessToken } from '../components/Auth/PasswordGate';

const BASE_URL = '';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { 'X-Access-Token': token } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw await responseError(res);
}

async function responseError(res: Response): Promise<ApiError> {
  const text = await res.text();
  if (!text) return new ApiError(res.statusText, res.status);

  try {
    const payload = JSON.parse(text) as {
      error?: unknown;
      code?: unknown;
      codeRequired?: unknown;
    };
    if (typeof payload.error === 'string') {
      return new ApiError(
        payload.error,
        res.status,
        typeof payload.code === 'string' ? payload.code : undefined,
        payload.codeRequired === true,
      );
    }
  } catch {
    return new ApiError(text, res.status);
  }

  return new ApiError(text, res.status);
}
