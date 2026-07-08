import type { ChannelAdapterEntry } from "./adapter.js";
import { feishuAdapterEntry } from "./feishu.js";
import { telegramAdapterEntry } from "./telegram.js";
import { wechatAdapterEntry } from "./wechat.js";

export class ChannelAdapterRegistry {
  private readonly entries = new Map<string, ChannelAdapterEntry>();

  register(entry: ChannelAdapterEntry): void {
    this.entries.set(entry.meta.kind, entry);
  }

  get(kind: string): ChannelAdapterEntry | undefined {
    return this.entries.get(kind);
  }

  list(): ChannelAdapterEntry[] {
    return [...this.entries.values()];
  }
}

export const channelAdapterRegistry = new ChannelAdapterRegistry();

export function registerBuiltInChannelAdapters(registry: ChannelAdapterRegistry = channelAdapterRegistry): ChannelAdapterRegistry {
  registry.register(telegramAdapterEntry);
  registry.register(feishuAdapterEntry);
  registry.register(wechatAdapterEntry);
  return registry;
}
