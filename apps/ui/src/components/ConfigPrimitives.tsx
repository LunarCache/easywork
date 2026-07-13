import type { ReactNode } from "react";

export function ConfigDisclosure({
  open,
  onToggle,
  summary,
  children,
  className = "",
  triggerClassName = "",
  testId,
  triggerTestId,
}: {
  open: boolean;
  onToggle: () => void;
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  testId?: string;
  triggerTestId?: string;
}) {
  return (
    <div className={`config-disclosure ${className} ${open ? "open" : ""}`.trim()} data-testid={testId}>
      <button
        className={triggerClassName}
        data-testid={triggerTestId}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        {summary}
      </button>
      {open && children}
    </div>
  );
}

export function ConfigToolbar({
  children,
  actions,
  className = "",
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`cfg-toolbar ${className}`.trim()}>
      {children}
      {actions && (
        <>
          <span className="bar-spacer" />
          <div className="cfg-toolbar-actions">{actions}</div>
        </>
      )}
    </div>
  );
}

export function ConfigEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cfg-empty-state">
      {icon}
      <p>{title}</p>
      {description && <span>{description}</span>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ConfigResourceCard({
  icon,
  children,
  actions,
  className = "",
  testId,
}: {
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={`mdl-card cfg-resource-card ${className}`.trim()} data-testid={testId}>
      {icon}
      <div className="cfg-resource-main">{children}</div>
      {actions && <div className="cfg-resource-actions">{actions}</div>}
    </div>
  );
}
