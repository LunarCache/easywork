import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createWriteTool } from "@earendil-works/pi-coding-agent";

// R5b #5：锁定工作区限定假设——pi 的 write 工具把相对路径解析到我们传入的 cwd（而非 process.cwd()）。
// 这是 EasyWork 工作区 cwd 注入（SessionHost.run cwd）的安全/正确性基石。bash 是真 shell，
// 由 R4 审批门把守（read-only/approve-each 下需批准），不在此覆盖。
describe("pi write tool 限定在 session cwd", () => {
  it("相对路径写入 cwd 内（不落到 process.cwd()）", async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-conf-")));
    try {
      const tool = createWriteTool(cwd);
      await tool.execute("c1", { path: "note.txt", content: "hi" });
      await tool.execute("c2", { path: "sub/deep.txt", content: "deep" });
      expect(fs.readFileSync(path.join(cwd, "note.txt"), "utf8")).toBe("hi");
      expect(fs.readFileSync(path.join(cwd, "sub/deep.txt"), "utf8")).toBe("deep");
      // 不应泄漏到仓库工作目录（此前 e2e 见过的越界产物）。
      expect(fs.existsSync(path.join(process.cwd(), "note.txt"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("记录 pi 原始行为：write 自身不挡 ../ 逃逸（故我们在权限层兜底）", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-conf-parent-")));
    const cwd = path.join(parent, "ws");
    fs.mkdirSync(cwd);
    try {
      const tool = createWriteTool(cwd);
      await tool.execute("c1", { path: "../escape.txt", content: "x" }).catch(() => {});
      // pi 自带 write 不做路径沙箱 → 越界文件确实落到了 parent。
      // EasyWork 在 permissionExtensionFactory（escapesCwd）里拦截，见 permission.test。
      expect(fs.existsSync(path.join(parent, "escape.txt"))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
