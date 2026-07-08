import type { CSSProperties } from "react";
import discordSvg from "simple-icons/icons/discord.svg?raw";
import telegramSvg from "simple-icons/icons/telegram.svg?raw";
import wechatSvg from "simple-icons/icons/wechat.svg?raw";
import anthropicSvg from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import azureSvg from "@lobehub/icons-static-svg/icons/azure-color.svg?raw";
import bedrockSvg from "@lobehub/icons-static-svg/icons/bedrock-color.svg?raw";
import cerebrasSvg from "@lobehub/icons-static-svg/icons/cerebras-color.svg?raw";
import cloudflareSvg from "@lobehub/icons-static-svg/icons/cloudflare-color.svg?raw";
import copilotSvg from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import deepseekSvg from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import fireworksSvg from "@lobehub/icons-static-svg/icons/fireworks-color.svg?raw";
import geminiSvg from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import googleSvg from "@lobehub/icons-static-svg/icons/google-color.svg?raw";
import groqSvg from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import huggingFaceSvg from "@lobehub/icons-static-svg/icons/huggingface-color.svg?raw";
import kimiSvg from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import metaSvg from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";
import minimaxSvg from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import mistralSvg from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import nvidiaSvg from "@lobehub/icons-static-svg/icons/nvidia-color.svg?raw";
import openaiSvg from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import openRouterSvg from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import qwenSvg from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import siliconCloudSvg from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg?raw";
import togetherSvg from "@lobehub/icons-static-svg/icons/together-color.svg?raw";
import vercelSvg from "@lobehub/icons-static-svg/icons/vercel.svg?raw";
import xaiSvg from "@lobehub/icons-static-svg/icons/xai.svg?raw";
import xiaomiSvg from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw";
import zaiSvg from "@lobehub/icons-static-svg/icons/zai.svg?raw";
import zhipuSvg from "@lobehub/icons-static-svg/icons/zhipu-color.svg?raw";

export type BrandKey =
  | "amazon-bedrock"
  | "anthropic"
  | "azure"
  | "cerebras"
  | "cloudflare"
  | "copilot"
  | "deepseek"
  | "discord"
  | "feishu"
  | "fireworks"
  | "gemini"
  | "google"
  | "groq"
  | "huggingface"
  | "local"
  | "meta"
  | "minimax"
  | "mistral"
  | "moonshot"
  | "nvidia"
  | "openai"
  | "openrouter"
  | "qwen"
  | "siliconflow"
  | "telegram"
  | "together"
  | "vercel"
  | "wechat"
  | "wecom"
  | "xai"
  | "xiaomi"
  | "zai"
  | "zhipu"
  | "generic";

const BRAND_LABELS: Record<BrandKey, { label: string; mark: string }> = {
  "amazon-bedrock": { label: "Amazon Bedrock", mark: "AWS" },
  anthropic: { label: "Anthropic", mark: "A" },
  azure: { label: "Azure OpenAI", mark: "Az" },
  cerebras: { label: "Cerebras", mark: "C" },
  cloudflare: { label: "Cloudflare", mark: "CF" },
  copilot: { label: "GitHub Copilot", mark: "Co" },
  deepseek: { label: "DeepSeek", mark: "D" },
  discord: { label: "Discord", mark: "Di" },
  feishu: { label: "Feishu / Lark", mark: "飞" },
  fireworks: { label: "Fireworks", mark: "Fw" },
  gemini: { label: "Gemini", mark: "G" },
  google: { label: "Google", mark: "G" },
  groq: { label: "Groq", mark: "Gq" },
  huggingface: { label: "Hugging Face", mark: "HF" },
  local: { label: "Local model", mark: "L" },
  meta: { label: "Meta", mark: "M" },
  minimax: { label: "MiniMax", mark: "Mx" },
  mistral: { label: "Mistral", mark: "Mi" },
  moonshot: { label: "Moonshot / Kimi", mark: "K" },
  nvidia: { label: "NVIDIA", mark: "Nv" },
  openai: { label: "OpenAI", mark: "O" },
  openrouter: { label: "OpenRouter", mark: "OR" },
  qwen: { label: "Qwen", mark: "Q" },
  siliconflow: { label: "SiliconFlow", mark: "硅" },
  telegram: { label: "Telegram", mark: "T" },
  together: { label: "Together AI", mark: "Tg" },
  vercel: { label: "Vercel AI Gateway", mark: "V" },
  wechat: { label: "WeChat", mark: "微" },
  wecom: { label: "WeCom", mark: "企" },
  xai: { label: "xAI", mark: "x" },
  xiaomi: { label: "Xiaomi MiMo", mark: "米" },
  zai: { label: "ZAI", mark: "Z" },
  zhipu: { label: "Zhipu AI", mark: "智" },
  generic: { label: "Provider", mark: "AI" },
};

const RAW_ICONS: Partial<Record<BrandKey, { svg: string; mono?: boolean; color?: string }>> = {
  "amazon-bedrock": { svg: bedrockSvg },
  anthropic: { svg: anthropicSvg, mono: true, color: "#191919" },
  azure: { svg: azureSvg },
  cerebras: { svg: cerebrasSvg },
  cloudflare: { svg: cloudflareSvg },
  copilot: { svg: copilotSvg, mono: true },
  deepseek: { svg: deepseekSvg },
  discord: { svg: discordSvg, mono: true, color: "#5865F2" },
  fireworks: { svg: fireworksSvg },
  gemini: { svg: geminiSvg },
  google: { svg: googleSvg },
  groq: { svg: groqSvg, mono: true },
  huggingface: { svg: huggingFaceSvg },
  local: { svg: huggingFaceSvg },
  meta: { svg: metaSvg },
  minimax: { svg: minimaxSvg },
  mistral: { svg: mistralSvg },
  moonshot: { svg: kimiSvg },
  nvidia: { svg: nvidiaSvg },
  openai: { svg: openaiSvg, mono: true },
  openrouter: { svg: openRouterSvg, mono: true },
  qwen: { svg: qwenSvg },
  siliconflow: { svg: siliconCloudSvg },
  telegram: { svg: telegramSvg, mono: true, color: "#26A5E4" },
  together: { svg: togetherSvg },
  vercel: { svg: vercelSvg, mono: true },
  wechat: { svg: wechatSvg, mono: true, color: "#07C160" },
  xai: { svg: xaiSvg, mono: true },
  xiaomi: { svg: xiaomiSvg, mono: true },
  zai: { svg: zaiSvg, mono: true },
  zhipu: { svg: zhipuSvg },
};

function normalized(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function brandKeyForProvider(id?: string, baseUrl?: string): BrandKey {
  const text = normalized(id, baseUrl);
  if (/amazon-bedrock|bedrock|aws/.test(text)) return "amazon-bedrock";
  if (/azure/.test(text)) return "azure";
  if (/openrouter/.test(text)) return "openrouter";
  if (/deepseek/.test(text)) return "deepseek";
  if (/siliconflow|硅基/.test(text)) return "siliconflow";
  if (/anthropic|claude/.test(text)) return "anthropic";
  if (/gemini/.test(text)) return "gemini";
  if (/google|generativelanguage|vertex/.test(text)) return "google";
  if (/github-copilot|copilot/.test(text)) return "copilot";
  if (/groq/.test(text)) return "groq";
  if (/\bxai\b|grok/.test(text)) return "xai";
  if (/cerebras/.test(text)) return "cerebras";
  if (/cloudflare/.test(text)) return "cloudflare";
  if (/fireworks/.test(text)) return "fireworks";
  if (/huggingface|hugging-face|hugging face/.test(text)) return "huggingface";
  if (/minimax/.test(text)) return "minimax";
  if (/nvidia|nim/.test(text)) return "nvidia";
  if (/together/.test(text)) return "together";
  if (/vercel/.test(text)) return "vercel";
  if (/xiaomi|mimo/.test(text)) return "xiaomi";
  if (/qwen|dashscope|aliyun|alibaba/.test(text)) return "qwen";
  if (/moonshot|kimi/.test(text)) return "moonshot";
  if (/\bzai\b/.test(text)) return "zai";
  if (/zhipu|glm/.test(text)) return "zhipu";
  if (/mistral/.test(text)) return "mistral";
  if (/openai|gpt/.test(text)) return "openai";
  return "generic";
}

export function brandKeyForModel(repoId?: string, fileName?: string, arch?: string): BrandKey {
  const text = normalized(repoId, fileName, arch);
  if (/deepseek/.test(text)) return "deepseek";
  if (/qwen|qwq|alibaba/.test(text)) return "qwen";
  if (/llama|meta/.test(text)) return "meta";
  if (/mistral|mixtral|codestral/.test(text)) return "mistral";
  if (/gemma|google/.test(text)) return "google";
  if (/glm|zhipu/.test(text)) return "zhipu";
  if (/kimi|moonshot/.test(text)) return "moonshot";
  return "local";
}

export function brandKeyForChannel(kind: string): BrandKey {
  if (kind === "wechat") return "wechat";
  if (kind === "wecom") return "wecom";
  if (kind === "feishu") return "feishu";
  if (kind === "telegram") return "telegram";
  if (kind === "discord") return "discord";
  return "generic";
}

export function BrandIcon({
  brand,
  size = "md",
  title,
}: {
  brand: BrandKey;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const meta = BRAND_LABELS[brand] ?? BRAND_LABELS.generic;
  const raw = RAW_ICONS[brand];
  if (raw) {
    const style = raw.color ? ({ "--brand-color": raw.color } as CSSProperties) : undefined;
    return (
      <span
        className={`brand-icon brand-${brand} ${size} has-svg ${raw.mono ? "mono-svg" : ""}`}
        title={title ?? meta.label}
        aria-label={title ?? meta.label}
        style={style}
        dangerouslySetInnerHTML={{ __html: raw.svg }}
      />
    );
  }
  return (
    <span className={`brand-icon brand-${brand} ${size}`} title={title ?? meta.label} aria-label={title ?? meta.label}>
      <span className="brand-mark">{meta.mark}</span>
    </span>
  );
}
