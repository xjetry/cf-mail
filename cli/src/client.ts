/**
 * cf-mail 管理 API 客户端（零运行时依赖，Node >= 18）
 */
export type DestinationTarget = {
  address: string;
  enabled: boolean;
};

export type ForwardRule = {
  address: string;
  destinations: string[];
  targets?: DestinationTarget[];
  updatedAt: string;
};

export type DeliveryLog = {
  id: string;
  ts: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  forwardedTo: string[];
  rejected?: boolean;
  reason?: string;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ClientOptions = {
  /** Worker 根地址，如 https://mail.example.com 或 http://localhost:8787 */
  baseUrl: string;
  /** 管理 API Bearer Token */
  token: string;
  /** 额外请求头（远程网关可能要求，如 X-Auth-Token） */
  headers?: Record<string, string>;
};

export function createClient(opts: ClientOptions) {
  const root = opts.baseUrl.replace(/\/+$/, "");
  const extraHeaders = opts.headers ?? {};

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(root + path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.token}`,
          ...extraHeaders,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new ApiError(0, `cannot reach ${root}: ${String(e)}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(res.status, String(data.error ?? res.statusText));
    }
    return data as T;
  }

  return {
    health: () => call<{ ok: boolean }>("/admin/healthz"),
    schema: () => call<Record<string, unknown>>("/admin/schema"),
    listRules: () => call<{ domain?: string; rules: ForwardRule[] }>("/admin/api/rules"),
    getRule: (address: string) =>
      call<{ rule: ForwardRule }>(`/admin/api/rules/${encodeURIComponent(address)}`),
    setRule: (address: string, destinations: string[]) =>
      call<{ rule: ForwardRule }>(`/admin/api/rules/${encodeURIComponent(address)}`, {
        method: "PUT",
        body: JSON.stringify({ destinations }),
      }),
    setTargetEnabled: (address: string, target: string, enabled: boolean) =>
      call<{ rule: ForwardRule }>(`/admin/api/rules/${encodeURIComponent(address)}/targets`, {
        method: "PATCH",
        body: JSON.stringify({ target, enabled }),
      }),
    deleteRule: (address: string) =>
      call<{ ok: boolean }>(`/admin/api/rules/${encodeURIComponent(address)}`, {
        method: "DELETE",
      }),
    listLogs: (limit = 50) =>
      call<{ logs: DeliveryLog[] }>(`/admin/api/logs?limit=${limit}`),
  };
}

export type Client = ReturnType<typeof createClient>;

/**
 * cfm（本地）与 cfmctl（远程）共用：
 * - cfm    → CFM_URL / CFM_TOKEN
 * - cfmctl → CFMCTL_URL / CFMCTL_TOKEN（或 --url/--token 参数）
 */
export function resolveConfig(
  env: Record<string, string | undefined>,
  flagUrl?: string,
  flagToken?: string,
): { baseUrl: string; token: string } {
  const baseUrl = flagUrl ?? env.CFMCTL_URL ?? env.CFM_URL ?? "http://localhost:8787";
  const token = flagToken ?? env.CFMCTL_TOKEN ?? env.CFM_TOKEN ?? "";
  if (!token) {
    throw new ApiError(
      1,
      "no token: set CFM_TOKEN (local) / CFMCTL_TOKEN (remote), or pass --token",
    );
  }
  return { baseUrl, token };
}
