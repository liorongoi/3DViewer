import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "./primitives";

type Part = "app" | "library" | "model" | "tools" | "dock" | "hud" | "popup" | "dialog";

interface Props {
  /** Which part of the interface this guards, named in the message. */
  part: Part;
  className?: string;
  children: ReactNode;
}

/**
 * An error boundary around one part of the interface. A fault while drawing that part shows
 * what failed, with Try again and Reload, instead of blanking the whole app; the 3D view sits
 * outside every boundary and keeps running.
 */
export class Guard extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[viewer] ${this.props.part} failed`, error, info.componentStack);
  }
  override render() {
    if (!this.state.error)
      return (
        <>
          {this.props.children}
          {TEST && <Tripwire part={this.props.part} />}
        </>
      );
    return <Fault part={this.props.part} error={this.state.error} className={this.props.className} onRetry={() => this.setState({ error: null })} />;
  }
}

// In ?test mode, window.__viewerFault = "<part>" makes that part fail, for scripts/check-faults.cjs.
const TEST = typeof location !== "undefined" && new URLSearchParams(location.search).has("test");
function Tripwire({ part }: { part: Part }): null {
  if ((window as unknown as { __viewerFault?: string }).__viewerFault === part) throw new Error(`Test fault in ${part}`);
  return null;
}

function Fault({ part, error, className, onRetry }: { part: Part; error: Error; className?: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" data-testid="fault" className={cx("glass pointer-events-auto max-w-[360px] rounded-[14px] p-4 text-[13px]", className)}>
      <div className="mb-1 font-semibold">{t("fault.title", { part: t(`fault.parts.${part}`) })}</div>
      <div className="mb-3 text-fg2">{t("fault.body")}</div>
      <details className="mb-3 text-[11px] text-fg3">
        <summary className="cursor-pointer">{t("fault.details")}</summary>
        <div dir="ltr" className="mt-1 break-words font-mono">{error.message}</div>
      </details>
      <div className="flex gap-2">
        <button type="button" className="rounded-[8px] bg-accent px-3 py-1.5 text-accent-on" onClick={onRetry}>
          {t("fault.retry")}
        </button>
        <button type="button" className="rounded-[8px] px-3 py-1.5 hover:bg-s3" onClick={() => location.reload()}>
          {t("fault.reload")}
        </button>
      </div>
    </div>
  );
}
