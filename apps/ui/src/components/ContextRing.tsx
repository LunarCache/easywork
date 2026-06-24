/** 上下文用量圆环（composer 内，靠近 Send）：仅环显示已用占比，百分比在 title 提示里。 */
export function ContextRing({ pct, title }: { pct: number; title?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const size = 20;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // 用量偏高时环转为告警色（>85% 红、>65% 琥珀，否则强调色）。
  const color = p > 85 ? "var(--err)" : p > 65 ? "var(--color-warning)" : "var(--accent)";
  return (
    <span className="ctx-ring" title={title ?? `上下文已用 ${Math.round(p)}%`}>
      <span className="ctx-ring-svg">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - p / 100)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </span>
    </span>
  );
}
