import {
  LocalModelRuntimeSettingsSchema,
  SamplingParamsSchema,
  type LocalModelRuntimeSettings,
  type SamplingParams,
} from "@ew/shared";

const SETTINGS_KEY = "models.local.settings";

interface SettingsKv {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
}

function parseSettingsMap(raw: string | null): Record<string, LocalModelRuntimeSettings> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LocalModelRuntimeSettings> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const checked = LocalModelRuntimeSettingsSchema.safeParse(value);
      if (checked.success && !settingsEmpty(checked.data)) out[id] = checked.data;
    }
    return out;
  } catch {
    return {};
  }
}

function samplingEmpty(sampling: SamplingParams | undefined): boolean {
  return !sampling || Object.keys(sampling).length === 0;
}

function settingsEmpty(settings: LocalModelRuntimeSettings): boolean {
  return samplingEmpty(settings.sampling);
}

function normalizeSettings(input: LocalModelRuntimeSettings): LocalModelRuntimeSettings {
  const settings = LocalModelRuntimeSettingsSchema.parse(input);
  if (settings.sampling) {
    const sampling = SamplingParamsSchema.parse(settings.sampling);
    return samplingEmpty(sampling) ? {} : { sampling };
  }
  return {};
}

export class LocalModelSettingsStore {
  constructor(private readonly kv: SettingsKv) {}

  private read(): Record<string, LocalModelRuntimeSettings> {
    return parseSettingsMap(this.kv.getSetting(SETTINGS_KEY));
  }

  private write(map: Record<string, LocalModelRuntimeSettings>): void {
    const entries = Object.entries(map).filter(([, settings]) => !settingsEmpty(settings));
    if (entries.length === 0) {
      this.kv.deleteSetting(SETTINGS_KEY);
      return;
    }
    this.kv.setSetting(SETTINGS_KEY, JSON.stringify(Object.fromEntries(entries)));
  }

  get(modelId: string | undefined): LocalModelRuntimeSettings {
    if (!modelId) return {};
    return this.read()[modelId] ?? {};
  }

  samplingFor(modelId: string | undefined): SamplingParams | undefined {
    const sampling = this.get(modelId).sampling;
    return samplingEmpty(sampling) ? undefined : sampling;
  }

  set(modelId: string, settings: LocalModelRuntimeSettings): LocalModelRuntimeSettings {
    const id = modelId.trim();
    if (!id) throw new Error("model id is required");
    const normalized = normalizeSettings(settings);
    const map = this.read();
    if (settingsEmpty(normalized)) delete map[id];
    else map[id] = normalized;
    this.write(map);
    return normalized;
  }

  deleteMany(modelIds: Array<string | undefined>): void {
    const map = this.read();
    let changed = false;
    for (const id of modelIds) {
      if (!id || !(id in map)) continue;
      delete map[id];
      changed = true;
    }
    if (changed) this.write(map);
  }
}
