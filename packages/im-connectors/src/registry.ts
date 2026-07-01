import type { ChannelAdapterEntry } from "./adapter.js";
import { telegramAdapterEntry } from "./telegram.js";

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
  return registry;
}
