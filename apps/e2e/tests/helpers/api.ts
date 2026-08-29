import { request } from 'undici';
import { env } from './env';

type JsonValue = unknown;

export type ApiResponse<T = JsonValue> = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  cookies: string[];
};

type ApiClientOpts = {
  accessToken?: string;
  apiKey?: string;
  refreshCookie?: string;
};

function parseSetCookie(h: string[] | string | undefined): string[] {
  if (!h) return [];
  return Array.isArray(h) ? h : [h];
}

function pickRefreshCookie(cookies: string[]): string | undefined {
  const match = cookies.find((c) => /^platform_refresh=/i.test(c));
  if (!match) return undefined;
  return match.split(';')[0];
}

export class ApiClient {
  private accessToken?: string;
  private refreshCookie?: string;
  private apiKey?: string;

  constructor(opts: ApiClientOpts = {}) {
    this.accessToken = opts.accessToken;
    this.apiKey = opts.apiKey;
    this.refreshCookie = opts.refreshCookie;
  }

  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  async raw<T = JsonValue>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, env.API_URL);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (this.refreshCookie) headers.cookie = this.refreshCookie;

    const res = await request(url.toString(), {
      method: method as any,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const cookies = parseSetCookie(res.headers['set-cookie']);
    const nextRefresh = pickRefreshCookie(cookies);
    if (nextRefresh) this.refreshCookie = nextRefresh;

    const text = await res.body.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.statusCode, headers: res.headers, body: body as T, cookies };
  }

  get<T = JsonValue>(path: string, query?: Record<string, string | number | undefined>) {
    return this.raw<T>('GET', path, { query });
  }
  post<T = JsonValue>(path: string, body?: unknown) {
    return this.raw<T>('POST', path, { body });
  }
  patch<T = JsonValue>(path: string, body?: unknown) {
    return this.raw<T>('PATCH', path, { body });
  }
  put<T = JsonValue>(path: string, body?: unknown) {
    return this.raw<T>('PUT', path, { body });
  }
  delete<T = JsonValue>(path: string) {
    return this.raw<T>('DELETE', path);
  }

  async login(email: string, password: string): Promise<{ accessToken: string; organizationId: string; userId: string }> {
    const res = await this.post<{ accessToken: string; organization: { id: string }; user: { id: string } }>(
      '/api/v1/auth/login',
      { email, password },
    );
    if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.accessToken = res.body.accessToken;
    return { accessToken: res.body.accessToken, organizationId: res.body.organization.id, userId: res.body.user.id };
  }
}

export async function healthCheck(): Promise<void> {
  const res = await request(`${env.API_URL}/health`);
  if (res.statusCode !== 200) throw new Error(`API /health returned ${res.statusCode}`);
  await res.body.dump();
}
