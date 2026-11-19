/**
 * Sequenced, Abort-Safe HTTP Client & Async Effect Helpers (Batch B).
 */

export class ApiClientError extends Error {
  readonly status: number;
  readonly isAborted: boolean;
  readonly isNetworkError: boolean;

  constructor(opts: {
    message: string;
    status: number;
    isAborted?: boolean;
    isNetworkError?: boolean;
  }) {
    super(opts.message);
    this.name = "ApiClientError";
    this.status = opts.status;
    this.isAborted = Boolean(opts.isAborted);
    this.isNetworkError = Boolean(opts.isNetworkError);
  }
}

export class RequestCoordinator {
  private seq = 0;
  private sessionController = new AbortController();
  private keyedControllers = new Map<string, AbortController>();

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  get sessionSignal(): AbortSignal {
    return this.sessionController.signal;
  }

  /**
   * Aborts all in-flight requests for the previous session (e.g. on logout / 401 / re-login).
   */
  resetSession(): void {
    this.sessionController.abort();
    this.sessionController = new AbortController();
    for (const ctrl of this.keyedControllers.values()) {
      ctrl.abort();
    }
    this.keyedControllers.clear();
  }

  /**
   * Creates an AbortSignal tied to both the active session and a specific channel (e.g. "inbox").
   * Calling startChannel("inbox") cancels any prior in-flight "inbox" query immediately.
   */
  startChannel(channel: string): { requestId: number; signal: AbortSignal } {
    const prev = this.keyedControllers.get(channel);
    if (prev) prev.abort();

    const ctrl = new AbortController();
    this.keyedControllers.set(channel, ctrl);

    const onSessionAbort = () => ctrl.abort();
    if (this.sessionController.signal.aborted) {
      ctrl.abort();
    } else {
      this.sessionController.signal.addEventListener("abort", onSessionAbort, {
        once: true,
      });
    }

    return {
      requestId: this.nextId(),
      signal: ctrl.signal,
    };
  }
}

export async function requestJson<T>(
  path: string,
  opts: {
    credential: string;
    epoch: number;
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    onUnauthorized?: (info: { epoch: number; usedCredential: string }) => void;
  },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.credential}`,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    const isAborted =
      err instanceof DOMException && err.name === "AbortError";
    throw new ApiClientError({
      message: isAborted ? "请求已取消" : "网络连接失败，请检查服务是否在线",
      status: 0,
      isAborted,
      isNetworkError: !isAborted,
    });
  }

  if (res.status === 401) {
    opts.onUnauthorized?.({
      epoch: opts.epoch,
      usedCredential: opts.credential,
    });
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiClientError({
      message: errBody.error || "凭证无效、已暂停或已过期",
      status: 401,
    });
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const serverMsg =
      typeof data.error === "string" && data.error
        ? data.error
        : `请求失败 (HTTP ${res.status})`;
    throw new ApiClientError({
      message: serverMsg,
      status: res.status,
    });
  }
  return data as T;
}
