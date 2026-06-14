import { describe, it, expect } from "vitest";
import { assertUrlAllowed, safeFetch } from "../src/ssrf.js";

// 伪 DNS lookup：按主机名返回预设地址。
function fakeLookup(map: Record<string, string[]>) {
  return (async (host: string) => {
    const addrs = map[host] ?? [];
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as never;
}

describe("SSRF assertUrlAllowed", () => {
  it("拒绝非 http(s) 协议", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toThrow();
    await expect(assertUrlAllowed("gopher://x")).rejects.toThrow();
  });

  it("拒绝 IP 字面量内网/环回/链路本地/元数据", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://172.16.3.4/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/", // 云元数据
      "http://[::1]/",
      "http://[fd00::1]/",
    ]) {
      await expect(assertUrlAllowed(u)).rejects.toThrow();
    }
  });

  it("拒绝 localhost 与解析到内网的域名", async () => {
    await expect(assertUrlAllowed("http://localhost/")).rejects.toThrow();
    await expect(
      assertUrlAllowed("http://evil.example/", fakeLookup({ "evil.example": ["10.1.2.3"] })),
    ).rejects.toThrow(/内网/);
  });

  it("放行解析到公网地址的域名", async () => {
    const u = await assertUrlAllowed("http://good.example/path", fakeLookup({ "good.example": ["93.184.216.34"] }));
    expect(u.hostname).toBe("good.example");
  });

  it("放行公网 IP 字面量", async () => {
    const u = await assertUrlAllowed("https://1.1.1.1/");
    expect(u.hostname).toBe("1.1.1.1");
  });
});

describe("safeFetch 重定向逐跳校验", () => {
  it("跟随到公网目标成功", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith("http://a.example")) {
        return new Response(null, { status: 302, headers: { location: "http://b.example/final" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await safeFetch("http://a.example/", {}, {
      fetchImpl,
      lookup: fakeLookup({ "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("重定向到内网被拒绝", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.startsWith("http://a.example")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
      }
      return new Response("should not reach", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      safeFetch("http://a.example/", {}, { fetchImpl, lookup: fakeLookup({ "a.example": ["93.184.216.34"] }) }),
    ).rejects.toThrow();
  });
});
