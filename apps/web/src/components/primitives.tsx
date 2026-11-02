import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateStatus } from "@viewer/shared";
import { CircleDashed, CircleDot, CircleHalf, CircleSlash } from "./icons";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: "sm" | "md";
}

/** Icon button with tooltip, shortcut and an accessible name (UI spec §6). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, active, size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tip={shortcut ? `${label}  ·  ${shortcut}` : label}
      className={cx(
        "tip relative grid place-items-center rounded-[8px] transition-colors duration-100",
        size === "md" ? "h-9 w-9" : "h-8 w-8",
        active ? "bg-accent-soft text-accent" : "text-fg2 hover:text-fg hover:bg-s3",
        "disabled:opacity-40 disabled:pointer-events-none",
        className,
      )}
      {...rest}
    >
      {children}
      {active && <span className="absolute bottom-0.5 h-0.5 w-4 rounded-full bg-accent" />}
    </button>
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num inline-grid min-w-5 h-5 place-items-center rounded border border-line-strong bg-s2 px-1 text-[11px] text-fg2">
      {children}
    </kbd>
  );
}

const STATUS_ICON: Record<UpdateStatus, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  draft: CircleDashed,
  inProduction: CircleHalf,
  current: CircleDot,
  superseded: CircleSlash,
};
const STATUS_VAR: Record<UpdateStatus, string> = {
  draft: "var(--status-draft)",
  inProduction: "var(--status-production)",
  current: "var(--status-current)",
  superseded: "var(--status-superseded)",
};

/** Status is never colour-only: icon + word (UI spec §4.2). */
export function StatusBadge({ status, compact }: { status: UpdateStatus; compact?: boolean }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium", compact ? "px-2 h-6 text-[12px]" : "px-2.5 h-7 text-[12px]")}
      style={{ color: STATUS_VAR[status], borderColor: "color-mix(in oklab, currentColor 35%, transparent)" }}
    >
      <Icon size={13} strokeWidth={2} />
      {t(`status.${status}`)}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[8px] bg-s2 p-0.5 border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 px-2.5 rounded-[6px] text-[12px] font-medium transition-colors",
            o.value === value ? "bg-s3 text-fg shadow-sm" : "text-fg3 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Divider({ vertical }: { vertical?: boolean }) {
  return <span aria-hidden className={vertical ? "mx-1 h-6 w-px bg-line" : "my-1 h-px w-full bg-line"} />;
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx("glass rounded-[14px] flex flex-col overflow-hidden", className)}>{children}</section>;
}
