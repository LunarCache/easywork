import dns from "node:dns/promises";
import net from "node:net";

/** SSRF 防护：拒绝指向私网/环回/链路本地/元数据等地址的请求，并在重定向后逐跳重新校验。 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inV4Range(ipInt: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const baseInt = ipv4ToInt(base!);
  if (baseInt == null) return false;
  const bits = Number(bitsStr);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// 私网 / 保留 / 特殊用途 IPv4 段（含云元数据 169.254.169.254 落在 169.254/16）。
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return true; // 解析不出当作不安全
  return BLOCKED_V4.some((c) => inV4Range(n, c));
}

function isBlockedIpv6(ip: string): boolean {
  const a = ip.toLowerCase().split("%")[0]!; // 去掉 zone id
  if (a === "::1" || a === "::") return true; // 环回 / 未指定
  // IPv4-mapped / compatible（::ffff:x.x.x.x 或 ::x.x.x.x）→ 取出 v4 校验
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return isBlockedIpv4(v4[1]!);
  const head = a.replace(/:.*$/, "");
  // fc00::/7 (ULA: fc/fd)、fe80::/10 (链路本地)、ff00::/8 (组播)
  if (/^f[cd]/.test(a)) return true;
  if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb"))
    return true;
  if (a.startsWith("ff")) return true;
  return false;
}

function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true;
}

/** 校验单个 URL：协议必须 http(s)，且其解析出的所有地址都不得命中黑名单。抛错=拒绝。 */
export async function assertUrlAllowed(rawUrl: string, lookup = dns.lookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("非法 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅允许 http(s) 协议");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // 主机本身就是 IP 字面量
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`拒绝访问内网/保留地址：${host}`);
    return u;
  }
  if (host.toLowerCase() === "localhost") throw new Error("拒绝访问 localhost");
  // 域名 → DNS 解析所有地址，全部校验（防 DNS rebinding 的首道防线）
  let addrs: { address: string }[];
  try {
    addrs = (await lookup(host, { all: true })) as { address: string }[];
  } catch {
    throw new Error(`DNS 解析失败：${host}`);
  }
  if (addrs.length === 0) throw new Error(`无法解析主机：${host}`);
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new Error(`主机 ${host} 解析到内网地址 ${a.address}，已拒绝`);
  }
  return u;
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  lookup?: typeof dns.lookup;
  fetchImpl?: typeof fetch;
}

/** 带 SSRF 防护的 fetch：手动跟随重定向，对每一跳都重新校验目标地址。 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const lookup = opts.lookup ?? dns.lookup;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertUrlAllowed(current, lookup);
    const res = await doFetch(u.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, u).toString();
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}
