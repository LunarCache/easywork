import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SERVICE = "ai.easywork.channel-secrets";

export interface ChannelSecretStore {
  get(connectorId: string): Record<string, string>;
  set(connectorId: string, secrets: Record<string, string>): void;
  delete(connectorId: string): void;
}

export class MemoryChannelSecretStore implements ChannelSecretStore {
  private readonly values = new Map<string, Record<string, string>>();

  get(connectorId: string): Record<string, string> {
    return { ...(this.values.get(connectorId) ?? {}) };
  }

  set(connectorId: string, secrets: Record<string, string>): void {
    this.values.set(connectorId, { ...secrets });
  }

  delete(connectorId: string): void {
    this.values.delete(connectorId);
  }
}

class MacOsKeychainSecretStore implements ChannelSecretStore {
  get(connectorId: string): Record<string, string> {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", connectorId, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return parseSecrets(raw);
    } catch (error) {
      if (commandStatus(error) === 44) return {};
      throw secretStoreError("读取 macOS Keychain 失败", error);
    }
  }

  set(connectorId: string, secrets: Record<string, string>): void {
    try {
      execFileSync("security", [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        connectorId,
        "-w",
        JSON.stringify(secrets),
      ], { stdio: "ignore" });
    } catch (error) {
      throw secretStoreError("写入 macOS Keychain 失败", error);
    }
  }

  delete(connectorId: string): void {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", connectorId], { stdio: "ignore" });
    } catch (error) {
      if (commandStatus(error) === 44) return;
      throw secretStoreError("清理 macOS Keychain 失败", error);
    }
  }
}

class LinuxSecretServiceStore implements ChannelSecretStore {
  get(connectorId: string): Record<string, string> {
    try {
      const raw = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", connectorId], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return parseSecrets(raw);
    } catch (error) {
      if (commandStatus(error) === 1) return {};
      throw secretStoreError("读取 Linux Secret Service 失败（请安装 secret-tool 并解锁 keyring）", error);
    }
  }

  set(connectorId: string, secrets: Record<string, string>): void {
    try {
      execFileSync(
        "secret-tool",
        ["store", "--label", `EasyWork channel ${connectorId}`, "service", SERVICE, "account", connectorId],
        { input: JSON.stringify(secrets), stdio: ["pipe", "ignore", "ignore"] },
      );
    } catch (error) {
      throw secretStoreError("写入 Linux Secret Service 失败（请安装 secret-tool 并解锁 keyring）", error);
    }
  }

  delete(connectorId: string): void {
    try {
      execFileSync("secret-tool", ["clear", "service", SERVICE, "account", connectorId], { stdio: "ignore" });
    } catch (error) {
      if (commandStatus(error) === 1) return;
      throw secretStoreError("清理 Linux Secret Service 失败", error);
    }
  }
}

class WindowsDpapiSecretStore implements ChannelSecretStore {
  constructor(private readonly dir: string) {}

  get(connectorId: string): Record<string, string> {
    const file = this.file(connectorId);
    if (!fs.existsSync(file)) return {};
    const script = [
      "$encrypted=[IO.File]::ReadAllBytes($env:EW_CHANNEL_SECRET_FILE)",
      "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Convert]::ToBase64String($plain))",
    ].join(";");
    try {
      const encoded = runPowerShell(script, { EW_CHANNEL_SECRET_FILE: file }).trim();
      return parseSecrets(Buffer.from(encoded, "base64").toString("utf8"));
    } catch (error) {
      throw secretStoreError("读取 Windows DPAPI 渠道密钥失败", error);
    }
  }

  set(connectorId: string, secrets: Record<string, string>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(connectorId);
    const script = [
      "$plain=[Convert]::FromBase64String($env:EW_CHANNEL_SECRET)",
      "$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[IO.File]::WriteAllBytes($env:EW_CHANNEL_SECRET_FILE,$encrypted)",
    ].join(";");
    try {
      runPowerShell(script, {
        EW_CHANNEL_SECRET: Buffer.from(JSON.stringify(secrets), "utf8").toString("base64"),
        EW_CHANNEL_SECRET_FILE: file,
      });
    } catch (error) {
      throw secretStoreError("写入 Windows DPAPI 渠道密钥失败", error);
    }
  }

  delete(connectorId: string): void {
    fs.rmSync(this.file(connectorId), { force: true });
  }

  private file(connectorId: string): string {
    const name = createHash("sha256").update(connectorId).digest("hex");
    return path.join(this.dir, `${name}.bin`);
  }
}

export function createChannelSecretStore(dataDir: string, platform: NodeJS.Platform = process.platform): ChannelSecretStore {
  if (platform === "darwin") return new MacOsKeychainSecretStore();
  if (platform === "win32") return new WindowsDpapiSecretStore(path.join(dataDir, "secrets", "channels"));
  if (platform === "linux") return new LinuxSecretServiceStore();
  throw new Error(`当前平台不支持系统渠道密钥存储: ${platform}`);
}

function parseSecrets(raw: string): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("渠道密钥格式无效");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

function commandStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}

function secretStoreError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function runPowerShell(script: string, extraEnv: Record<string, string>): string {
  const env = { ...process.env, ...extraEnv };
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (firstError) {
    if (typeof firstError !== "object" || firstError === null || !("code" in firstError) || firstError.code !== "ENOENT") throw firstError;
    return execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
}
