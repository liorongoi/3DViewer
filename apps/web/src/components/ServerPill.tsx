import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../state/store";
import { desktopInfo } from "../desktop";
import { cx } from "./primitives";

/**
 * Whether the library server answers (WP 5.4), on the library panel and in a model's top bar.
 * Shown only where a server is expected; the app
 * switches between library mode and local mode by itself as the network comes and goes.
 */
export function ServerPill({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const state = useApp((s) => s.serverState);
  const [address, setAddress] = useState<string>(location.host);
  useEffect(() => {
    void desktopInfo().then((d) => d?.serverAddress && setAddress(d.serverAddress));
  }, []);
  if (state === "none") return null;
  const online = state === "online";
  return (
    <span
      role="status"
      data-testid="server-state"
      data-state={state}
      title={online ? t("common.onlineHint", { address }) : t("common.offlineHint")}
      aria-label={online ? t("common.online") : t("common.offline")}
      className={cx("inline-flex items-center gap-1 rounded-full bg-s2 leading-[18px]", compact && online ? "h-6 w-6 justify-center" : "px-1.5")}
    >
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", online ? "bg-[var(--status-current)]" : "bg-[var(--status-production)]")} />
      {/* In a model's top bar an online server is only a dot; offline always says so. */}
      {compact && online ? null : online ? t("common.online") : t("common.offline")}
    </span>
  );
}
