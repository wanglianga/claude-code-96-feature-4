// 后端 API 封装：token 存 localStorage，同一文件内防重复提交
const TOKEN_KEY = "fu_token";
const USER_KEY = "fu_user";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function getSessionUser(): any | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function setSession(token: string, user: any) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; form?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!opts.form) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.form ? opts.form : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.detail || `请求失败（${res.status}）`);
  }
  return data as T;
}

export function newIdempotencyKey(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
