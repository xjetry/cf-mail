/**
 * Cloudflare Email Routing Destination Addresses 客户端：
 * - 检查转发目标邮箱是否已添加并通过验证（message.forward() 只能发往已验证地址）
 * - 创建目标地址（自动触发 Cloudflare 验证邮件），对未验证地址支持重发验证邮件
 *
 * 依赖环境变量（未配置时所有检查降级为 unknown，不影响规则保存）：
 * - CLOUDFLARE_API_TOKEN：需 Account → Email Routing Addresses → Edit 权限
 * - CF_ACCOUNT_ID：目标域名所属 Account ID
 */

export type DestinationStatus = "verified" | "pending" | "missing" | "unknown";

export type DestinationVerification = {
  address: string;
  status: DestinationStatus;
  verifiedAt?: string;
  message?: string;
};

export type DestinationCheckResult = {
  configured: boolean;
  destinations: DestinationVerification[];
};

export type CfDestinationEnv = {
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
};

type CfAddress = {
  id: string;
  email: string;
  verified?: string | null;
};

type CfEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  result_info?: { total_pages?: number };
};

const CF_API = "https://api.cloudflare.com/client/v4";

function normalize(addr: string): string {
  return addr.trim().toLowerCase();
}

function formatErrors(data: CfEnvelope<unknown>, fallback: string): string {
  const errs = (data.errors ?? []).map((e) => `[${e.code}] ${e.message}`);
  return errs.length > 0 ? errs.join("; ") : fallback;
}

async function cfRequest<T>(
  env: CfDestinationEnv,
  path: string,
  init?: RequestInit,
): Promise<CfEnvelope<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return (await res.json().catch(() => ({
    success: false,
    result: null,
    errors: [{ code: res.status, message: res.statusText }],
  }))) as CfEnvelope<T>;
}

export function isDestinationCheckConfigured(env: CfDestinationEnv): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN?.trim() && env.CF_ACCOUNT_ID?.trim());
}

/** 拉取账户下全部 Destination Addresses（分页），返回 email 小写 → 地址记录 的映射 */
async function listAddressMap(
  env: CfDestinationEnv,
): Promise<{ map: Map<string, CfAddress> } | { error: string }> {
  const map = new Map<string, CfAddress>();
  let page = 1;
  // 防御性上限：50/页 × 20 页 = 1000 个地址，远超实际使用
  while (page <= 20) {
    const data = await cfRequest<CfAddress[]>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses?per_page=50&page=${page}`,
    );
    if (!data.success || !Array.isArray(data.result)) {
      return { error: formatErrors(data, "failed to list destination addresses") };
    }
    for (const item of data.result) {
      if (item?.email) map.set(normalize(item.email), item);
    }
    const totalPages = data.result_info?.total_pages ?? page;
    if (data.result.length < 50 || page >= totalPages) break;
    page++;
  }
  return { map };
}

export async function checkDestinations(
  env: CfDestinationEnv,
  addresses: string[],
): Promise<DestinationCheckResult> {
  const targets = [...new Set(addresses.map(normalize).filter(Boolean))];
  if (!isDestinationCheckConfigured(env)) {
    return {
      configured: false,
      destinations: targets.map((address) => ({
        address,
        status: "unknown" as const,
        message: "Worker 未配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID，无法检查验证状态",
      })),
    };
  }
  try {
    const listed = await listAddressMap(env);
    if ("error" in listed) {
      return {
        configured: true,
        destinations: targets.map((address) => ({
          address,
          status: "unknown" as const,
          message: `验证状态检查失败: ${listed.error}`,
        })),
      };
    }
    return {
      configured: true,
      destinations: targets.map((address) => {
        const record = listed.map.get(address);
        if (!record) {
          return {
            address,
            status: "missing" as const,
            message: "未添加到 Cloudflare Destination Addresses，转发会失败，请先发送验证邮件",
          };
        }
        if (record.verified) {
          return {
            address,
            status: "verified" as const,
            verifiedAt: record.verified,
          };
        }
        return {
          address,
          status: "pending" as const,
          message: "已添加但未验证，请查收验证邮件（或重发）并点击其中的验证链接",
        };
      }),
    };
  } catch (e) {
    return {
      configured: true,
      destinations: targets.map((address) => ({
        address,
        status: "unknown" as const,
        message: `验证状态检查异常: ${String(e)}`,
      })),
    };
  }
}

export type SendVerificationResult = {
  destination: DestinationVerification;
  action: "sent" | "resent" | "already_verified";
  message: string;
};

/**
 * 发送/重发验证邮件：
 * - missing → 直接创建（Cloudflare 自动发送验证邮件）
 * - pending → 先尝试重复创建以触发重发；若 Cloudflare 拒绝（地址已存在），
 *   则删除该「未验证」地址后重新创建以强制重发（未验证地址本就无法用于转发，删除无副作用）
 * - verified → 不执行任何操作
 */
export async function sendDestinationVerification(
  env: CfDestinationEnv,
  rawAddress: string,
): Promise<SendVerificationResult> {
  const address = normalize(rawAddress);
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(`invalid destination address: ${rawAddress}`);
  }
  if (!isDestinationCheckConfigured(env)) {
    throw new Error(
      "Worker 未配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID，无法发送验证邮件（请通过 npm run deploy 重新部署以自动注入）",
    );
  }

  const listed = await listAddressMap(env);
  if ("error" in listed) throw new Error(listed.error);
  const existing = listed.map.get(address);

  if (existing?.verified) {
    return {
      destination: { address, status: "verified", verifiedAt: existing.verified },
      action: "already_verified",
      message: `${address} 已通过验证，无需重复操作`,
    };
  }

  const create = () =>
    cfRequest<CfAddress>(env, `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, {
      method: "POST",
      body: JSON.stringify({ email: address }),
    });

  let action: SendVerificationResult["action"] = existing ? "resent" : "sent";
  let created = await create();

  if (!created.success && existing) {
    // 地址已存在导致创建失败 → 删除未验证地址后重建，强制重发验证邮件
    const removed = await cfRequest<unknown>(
      env,
      `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses/${existing.id}`,
      { method: "DELETE" },
    );
    if (!removed.success) {
      throw new Error(
        `重发验证邮件失败（无法重置未验证地址）: ${formatErrors(removed, "delete failed")}`,
      );
    }
    created = await create();
  }

  if (!created.success) {
    throw new Error(`发送验证邮件失败: ${formatErrors(created, "create failed")}`);
  }

  return {
    destination: {
      address,
      status: "pending",
      message: "验证邮件已发送，请查收并点击邮件中的验证链接",
    },
    action,
    message:
      `${address} 的验证邮件已${action === "resent" ? "重新" : ""}发送，请查收（含垃圾邮件目录）并点击验证链接；` +
      `验证通过后用 check-dest / 状态检查确认为 verified 即可正常转发`,
  };
}
