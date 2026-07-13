import type { ReactNode } from "react";
import { ContextRing } from "./ContextRing.js";

export function ComposerContextStrip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`composer-active-strip${className ? ` ${className}` : ""}`}>{children}</div>;
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
    <span className={classes} {...(title ? { title } : {})} {...(testId ? { "data-testid": testId } : {})}>
      {children}
    </span>
  );
}

export function ComposerUsagePill({ pct, title, testId }: { pct: number; title?: string; testId?: string }) {
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
        {detail}
      </span>
    </span>
  );
}
