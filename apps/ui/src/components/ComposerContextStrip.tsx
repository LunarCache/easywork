import type { ReactNode } from "react";
import { ContextRing } from "./ContextRing.js";
import { formatTokenCount, formatUsagePct, type ContextUsagePart } from "../lib/context-usage.js";

export function ComposerContextStrip({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`composer-active-strip${className ? ` ${className}` : ""}`}>{children}</div>
  );
}

export function ComposerContextPill({
  children,
  onClick,
  title,
  tone = "default",
  className = "",
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  tone?: "default" | "on" | "strong";
  className?: string;
  testId?: string;
}) {
  const classes = `composer-strip-pill ${tone}${onClick ? " interactive" : ""}${className ? ` ${className}` : ""}`;
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        className={classes}
        {...(title ? { title } : {})}
        {...(testId ? { "data-testid": testId } : {})}
      >
        {children}
      </button>
    );
  return (
    <span
      className={classes}
      {...(title ? { title } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </span>
  );
}

export function ComposerUsagePill({
  pct,
  title,
  parts,
  testId,
}: {
  pct: number;
  title?: string;
  parts?: ContextUsagePart[];
  testId?: string;
}) {
  const rounded = Math.round(pct);
  const tone = pct > 85 ? "hot" : pct > 65 ? "warn" : "safe";
  const detail = title ?? `上下文已用 ${rounded}%`;
  return (
    <span className="composer-usage">
      <span
        className={`composer-strip-pill usage ${tone}`}
        role="meter"
        tabIndex={0}
        aria-label={detail}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.max(0, Math.min(100, rounded))}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <ContextRing pct={pct} />
      </span>
      <span
        className="composer-usage-tooltip"
        role="tooltip"
        {...(testId ? { "data-testid": `${testId}-tooltip` } : {})}
      >
        <span className="composer-usage-summary">{detail}</span>
        {parts && parts.length > 0 && (
          <span className="composer-usage-parts">
            {parts.map((part) => (
              <span
                key={part.key}
                className="composer-usage-part"
                {...(testId ? { "data-testid": `${testId}-${part.key}` } : {})}
              >
                <span className={`composer-usage-dot ${part.key}`} aria-hidden="true" />
                <span className="composer-usage-label">{part.label}</span>
                <span className="composer-usage-tokens">
                  {part.estimated ? "~" : ""}{formatTokenCount(part.tokens)}
                </span>
                <span className="composer-usage-pct">{formatUsagePct(part.pct)}</span>
              </span>
            ))}
          </span>
        )}
        {parts?.some((part) => part.estimated) && <span className="composer-usage-note">内容分类为估算</span>}
      </span>
    </span>
  );
}
