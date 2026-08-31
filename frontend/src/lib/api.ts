// Thin fetch wrapper for the real backend (LLD §2). All routes are mounted
// under /api (see src/app.ts) and proxied to the Express server in dev (see
// vite.config.ts). `credentials: "include"` is required on every call — auth
// is a session cookie (express-session), not a bearer token.
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `Request failed with status ${status}`;
}

async function rawRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "include", ...init });

  const contentType = res.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json") ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, body, errorMessage(body, res.status));
  }

  return body as T;
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return rawRequest<T>(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

function withBody(method: string, data?: unknown): RequestInit {
  return data !== undefined ? { method, body: JSON.stringify(data) } : { method };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, withBody("POST", data)),
  put: <T>(path: string, data?: unknown) => request<T>(path, withBody("PUT", data)),
  // multipart/form-data upload — no Content-Type override so the browser
  // sets the boundary itself (LLD §2.7: POST /resource/documents/:type).
  upload: <T>(path: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return rawRequest<T>(path, { method: "POST", body: formData });
  },
};
