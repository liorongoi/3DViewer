import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { BASE_MAPS, TERRAINS, fmtBytes } from "@viewer/core";
import { ServerError, type BaseMapConfig, type BaseMapSource, type ClassificationLevel } from "@viewer/shared";
import { useEngine } from "../engine";
import { saveText } from "../download";
import { getBaseMaps, listLevels } from "../server/api";
import { AdminApi, type AuditEntry, type StorageInfo } from "../server/admin-api";
import { refreshLibrary } from "../state/library";
import { useApp } from "../state/store";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Download, HardDrive, Layers, Lock, Map, Plus, ShieldCheck, Trash2, X } from "./icons";
import { IconButton, cx } from "./primitives";
import { useDialog } from "./useDialog";
import { errorText } from "../server/error-text";

/**
 * Admin page (WP 3.9, UI design 3.5): password sign-in, then classification levels, base map
 * sources, storage quota, permanent delete, the audit log and the password itself.
 */
type Tab = "levels" | "basemaps" | "storage" | "delete" | "audit" | "password";
const TABS: Tab[] = ["levels", "basemaps", "storage", "delete", "audit", "password"];

export function AdminPanel() {
  const { t } = useTranslation();
  const open = useApp((s) => s.adminOpen);
  const server = useApp((s) => s.server);
  const set = useApp((s) => s.set);
  const api = useMemo(() => (server ? new AdminApi(server) : null), [server]);
  const [state, setState] = useState<"loading" | "no-password" | "signed-out" | "signed-in">("loading");
  const [tab, setTab] = useState<Tab>("levels");

  useEffect(() => {
    if (!open || !api) return;
    setState("loading");
    void api
      .status()
      .then((s) => setState(!s.passwordSet ? "no-password" : s.signedIn ? "signed-in" : "signed-out"))
      .catch(() => setState("signed-out"));
  }, [open, api]);

  const ref = useDialog<HTMLDivElement>(open, { onClose: () => set({ adminOpen: false }) });

  if (!open) return null;
  const close = () => set({ adminOpen: false });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t("admin.title")} className="flex h-[min(760px,92vh)] border border-line bg-s1solid shadow-2xl w-[min(1040px,96vw)] flex-col rounded-[16px]">
        <header className="flex h-14 items-center gap-3 border-b border-line px-5">
          <ShieldCheck size={18} className="text-accent" />
          <h2 className="flex-1 text-[15px] font-semibold">{t("admin.title")}</h2>
          {state === "signed-in" && (
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await api!.logout();
                setState("signed-out");
              }}
            >
              {t("admin.signOut")}
            </button>
          )}
          <IconButton size="sm" label={t("common.close")} onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        {!api ? (
          <Centre>
            <p className="text-fg2">{t("admin.needsServer")}</p>
          </Centre>
        ) : state === "loading" ? (
          <Centre>
            <p className="text-fg3">{t("admin.checking")}</p>
          </Centre>
        ) : state === "no-password" ? (
          <Centre>
            <Lock size={22} className="text-fg3" />
            <p className="max-w-md text-center text-fg2">
              <Trans i18nKey="admin.noPassword" components={{ code: <code dir="ltr" /> }} />
            </p>
          </Centre>
        ) : state === "signed-out" ? (
          <SignIn api={api} onDone={() => setState("signed-in")} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-e border-line p-2" aria-label={t("admin.sections")}>
              {TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-current={tab === id ? "page" : undefined}
                  onClick={() => setTab(id)}
                  className={cx("h-9 rounded-[8px] px-3 text-start", tab === id ? "bg-accent-soft text-fg" : "text-fg2 hover:bg-s3")}
                >
                  {t(`admin.tabs.${id}`)}
                </button>
              ))}
            </nav>
            <div className="min-h-0 min-w-0 flex-1 overflow-auto p-5 scrollbar-thin">
              <Guarded onSignedOut={() => setState("signed-out")}>
                {(fail) =>
                  tab === "levels" ? <LevelsTab api={api} fail={fail} /> :
                  tab === "basemaps" ? <BaseMapsTab api={api} fail={fail} /> :
                  tab === "storage" ? <StorageTab api={api} fail={fail} /> :
                  tab === "delete" ? <DeleteTab api={api} fail={fail} /> :
                  tab === "audit" ? <AuditTab api={api} fail={fail} /> :
                  <PasswordTab api={api} fail={fail} />
                }
              </Guarded>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Centre({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">{children}</div>;
}

type Fail = (e: unknown) => void;

/** Shows errors from any tab in one place, and goes back to sign-in when the session has ended. */
function Guarded({ children, onSignedOut }: { children: (fail: Fail) => React.ReactNode; onSignedOut: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const fail: Fail = (e) => {
    if (e instanceof ServerError && e.key === "signIn") return onSignedOut();
    setError(errorText(e, t));
  };
  return (
    <>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-[10px] border border-[var(--bad)]/40 p-3 text-[13px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--bad)]" />
          <p className="flex-1 text-fg2">{error}</p>
          <IconButton size="sm" label={t("admin.dismiss")} onClick={() => setError(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {children(fail)}
    </>
  );
}

function SignIn({ api, onDone }: { api: AdminApi; onDone: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centre>
      <form onSubmit={submit} className="flex w-80 flex-col gap-3">
        <Lock size={22} className="self-center text-fg3" />
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.password")}
          <input type="password" autoFocus autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="text-[12px] text-[var(--bad)]">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary justify-center" disabled={!password || busy}>
          {busy ? t("admin.signingIn") : t("admin.signIn")}
        </button>
        <p className="text-center text-[11px] text-fg3">{t("admin.signInNote")}</p>
      </form>
    </Centre>
  );
}

function H({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[15px] font-semibold">{children}</h3>
      {note && <p className="mt-1 max-w-2xl text-[12px] text-fg3">{note}</p>}
    </div>
  );
}

// ---- Classification levels ----

/** WCAG 2.1 contrast ratio, the same rule the server applies. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
const isHex = (s: string) => /^#[0-9A-Fa-f]{6}$/.test(s);

async function reloadLevels(api: AdminApi): Promise<void> {
  const levels = await listLevels(api.srv);
  if (levels.length) useApp.setState({ levels });
}

function LevelsTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const levels = useApp((s) => s.levels);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const swap = async (i: number, j: number) => {
    const a = levels[i]!, b = levels[j]!;
    try {
      await api.saveLevel({ ...a, order: b.order });
      await api.saveLevel({ ...b, order: a.order });
      await reloadLevels(api);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <H note={t("admin.levelsNote")}>{t("admin.tabs.levels")}</H>
      {note && <p className="mb-3 text-[12px] text-fg2">{note}</p>}
      <ul className="flex flex-col gap-2">
        {levels.map((l, i) => (
          <LevelRow
            key={l.id}
            level={l}
            first={i === 0}
            last={i === levels.length - 1}
            onUp={() => void swap(i, i - 1)}
            onDown={() => void swap(i, i + 1)}
            onSave={async (next) => {
              try {
                const r = await api.saveLevel(next);
                await reloadLevels(api);
                setNote(r.thumbnailsQueued ? t("admin.savedThumbs", { count: r.thumbnailsQueued }) : t("admin.saved"));
                return true;
              } catch (e) {
                fail(e);
                return false;
              }
            }}
            onRemove={async () => {
              try {
                await api.removeLevel(l.id);
                await reloadLevels(api);
                setNote(t("admin.removed", { name: l.label }));
              } catch (e) {
                fail(e);
              }
            }}
          />
        ))}
      </ul>
      {adding ? (
        <div className="mt-3">
          <LevelRow
            level={{ id: "", label: "", color: "#4A4F59", textColor: "#FFFFFF", order: Math.max(0, ...levels.map((l) => l.order)) + 1 }}
            isNew
            onCancel={() => setAdding(false)}
            onSave={async (next) => {
              const id = next.label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `level-${Date.now().toString(36)}`;
              if (levels.some((l) => l.id === id)) {
                fail(new Error(t("admin.levelExists", { name: next.label })));
                return false;
              }
              try {
                await api.saveLevel({ ...next, id });
                await reloadLevels(api);
                setAdding(false);
                setNote(t("admin.added", { name: next.label }));
                return true;
              } catch (e) {
                fail(e);
                return false;
              }
            }}
          />
        </div>
      ) : (
        <button type="button" className="btn-secondary mt-3" onClick={() => setAdding(true)}>
          <Plus size={14} /> {t("admin.addLevel")}
        </button>
      )}
    </>
  );
}

function LevelRow(props: {
  level: ClassificationLevel;
  first?: boolean;
  last?: boolean;
  isNew?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onSave: (l: ClassificationLevel) => Promise<boolean>;
  onRemove?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const { level: l, isNew } = props;
  const [label, setLabel] = useState(l.label);
  const [color, setColor] = useState(l.color);
  const [text, setText] = useState(l.textColor);
  const [confirm, setConfirm] = useState(false);
  const valid = label.trim() && isHex(color) && isHex(text);
  const ratio = valid ? contrast(color, text) : 0;
  const changed = isNew || label !== l.label || color.toUpperCase() !== l.color.toUpperCase() || text.toUpperCase() !== l.textColor.toUpperCase();
  return (
    <li className="list-none rounded-[10px] border border-line bg-s2 p-3">
      <div className="mb-3 flex h-6 items-center justify-center rounded-[4px] text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ background: isHex(color) ? color : "#000", color: isHex(text) ? text : "#fff" }}>
        {label || t("admin.levelName")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-[12px] text-fg3">
          {t("admin.bannerName")}
          <input className="input" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <ColourField label={t("admin.band")} value={color} onChange={setColor} />
        <ColourField label={t("admin.text")} value={text} onChange={setText} />
        <span className={cx("num w-24 pb-2 text-[12px]", ratio >= 4.5 ? "text-fg2" : "text-[var(--bad)]")} title={t("admin.contrastTitle")}>
          {valid ? `${ratio.toFixed(1)}:1 ${ratio >= 4.5 ? t("admin.readable") : t("admin.tooLow")}` : "—"}
        </span>
        <div className="ms-auto flex items-center gap-1 pb-0.5">
          {!isNew && (
            <>
              <IconButton size="sm" label={t("admin.moveDown")} disabled={props.first} onClick={props.onUp}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton size="sm" label={t("admin.moveUp")} disabled={props.last} onClick={props.onDown}>
                <ArrowDown size={14} />
              </IconButton>
            </>
          )}
          <button type="button" className="btn-primary" disabled={!valid || ratio < 4.5 || !changed} onClick={() => void props.onSave({ ...l, label: label.trim(), color: color.toUpperCase(), textColor: text.toUpperCase() })}>
            <Check size={14} /> {isNew ? t("admin.add") : t("admin.save")}
          </button>
          {isNew ? (
            <button type="button" className="btn-ghost" onClick={props.onCancel}>
              {t("admin.cancel")}
            </button>
          ) : confirm ? (
            <>
              <button type="button" className="btn-ghost text-[var(--bad)]" onClick={() => (setConfirm(false), props.onRemove?.())}>
                {t("admin.removeForGood")}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirm(false)}>
                {t("admin.keep")}
              </button>
            </>
          ) : (
            <IconButton size="sm" label={t("admin.removeLevel")} onClick={() => setConfirm(true)}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
    </li>
  );
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1 text-[12px] text-fg3">
      {label}
      <span className="flex items-center gap-1">
        <input type="color" aria-label={t("admin.colourPicker", { label })} value={isHex(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-9 cursor-pointer rounded-[6px] border border-line bg-transparent" />
        <input dir="ltr" className="input !w-24 font-mono uppercase" value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} aria-label={t("admin.colourHex", { label })} />
      </span>
    </label>
  );
}

// ---- Base maps ----

/** Names of source types: an i18n key where the name has words, the standard's own name otherwise. */
const TYPE_LABEL: Record<BaseMapSource["type"], string> = {
  xyz: "admin.types.xyz",
  tms: "TMS",
  wmts: "WMTS",
  terrarium: "admin.types.terrarium",
  "quantized-mesh": "Quantized-mesh", // i18n-ignore: the format's name
};
const URL_HINT: Record<BaseMapSource["type"], string> = {
  xyz: "https://maps.internal/ortho/{z}/{x}/{y}.jpg  or  /basemap/ortho/{z}/{x}/{y}.jpg",
  tms: "https://maps.internal/tms/ortho",
  wmts: "https://maps.internal/wmts/1.0.0/WMTSCapabilities.xml",
  terrarium: "https://maps.internal/terrain/{z}/{x}/{y}.png",
  "quantized-mesh": "admin.folderHint",
};

function BaseMapsTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const [cfg, setCfg] = useState<BaseMapConfig | null>(null);
  const [draft, setDraft] = useState<BaseMapSource | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    void getBaseMaps(api.srv).then(setCfg).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!cfg) return <p className="text-fg3">{t("admin.loading")}</p>;

  const save = async (next: BaseMapConfig) => {
    const before = cfg;
    setCfg(next);
    try {
      const r = await api.saveBaseMaps(next);
      setCfg(r);
      const problems = (await engine?.useSiteBaseMaps(r, api.srv.base)) ?? [];
      setSaved(problems.length ? t("admin.savedBadSources", { problems: problems.join(" ") }) : t("admin.savedSources"));
    } catch (e) {
      setCfg(before);
      fail(e);
    }
  };
  const imagery = [...cfg.sources.filter((s) => s.kind === "imagery").map((s) => ({ id: s.id, label: s.label })), ...BASE_MAPS.filter((b) => !(cfg.hideOnline && b.online)).map((b) => ({ id: b.id, label: t(`catalogue.${b.id}`, { defaultValue: b.label }) }))];
  const terrain = [...cfg.sources.filter((s) => s.kind === "terrain").map((s) => ({ id: s.id, label: s.label })), ...TERRAINS.filter((x) => !(cfg.hideOnline && x.online)).map((x) => ({ id: x.id, label: t(`catalogue.${x.id}`, { defaultValue: x.label }) }))];

  return (
    <>
      <H note={t("admin.basemapsNote")}>{t("admin.basemapsTitle")}</H>
      {saved && <p className="mb-3 text-[12px] text-fg2">{saved}</p>}
      <ul className="mb-3 flex flex-col gap-1.5">
        {cfg.sources.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-[8px] border border-line bg-s2 px-3 py-2">
            {s.kind === "imagery" ? <Map size={14} className="text-fg3" /> : <Layers size={14} className="text-fg3" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{s.label}</span>
              <span className="block truncate text-[11px] text-fg3" dir="ltr">
                {t(TYPE_LABEL[s.type])} · {s.url}
                {s.layer ? ` · ${s.layer}` : ""}
              </span>
            </span>
            <button type="button" className="btn-ghost h-7" onClick={() => setDraft(s)}>
              {t("admin.edit")}
            </button>
            <IconButton size="sm" label={t("admin.removeSource", { name: s.label })} onClick={() => void save({ ...cfg, sources: cfg.sources.filter((x) => x.id !== s.id) })}>
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
        {!cfg.sources.length && <li className="text-[12px] text-fg3">{t("admin.noSources")}</li>}
      </ul>
      {draft ? (
        <SourceForm
          initial={draft}
          taken={cfg.sources.filter((s) => s !== draft).map((s) => s.id)}
          onCancel={() => setDraft(null)}
          onSave={async (s) => {
            const sources = cfg.sources.some((x) => x === draft) ? cfg.sources.map((x) => (x === draft ? s : x)) : [...cfg.sources, s];
            await save({ ...cfg, sources });
            setDraft(null);
          }}
        />
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setDraft({ id: "", label: "", kind: "imagery", type: "xyz", url: "" })}>
          <Plus size={14} /> {t("admin.addSource")}
        </button>
      )}

      <div className="mt-6 grid max-w-2xl grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <span className="text-fg2">{t("admin.opensWith")}</span>
        <select className="input" value={cfg.defaultImagery ?? ""} onChange={(e) => void save({ ...cfg, defaultImagery: e.target.value || undefined })} aria-label={t("admin.baseMapDefault")}>
          <option value="">{t("admin.viewersChoice")}</option>
          {imagery.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-fg2">{t("admin.terrain")}</span>
        <select className="input" value={cfg.defaultTerrain ?? ""} onChange={(e) => void save({ ...cfg, defaultTerrain: e.target.value || undefined })} aria-label={t("admin.terrainDefault")}>
          <option value="">{t("admin.viewersChoice")}</option>
          {terrain.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span />
        <label className="flex items-center gap-2 text-fg2">
          <input type="checkbox" checked={!!cfg.hideOnline} onChange={(e) => void save({ ...cfg, hideOnline: e.target.checked })} className="accent-[var(--accent)]" />
          {t("admin.hideOnline")}
        </label>
      </div>
    </>
  );
}

function SourceForm({ initial, taken, onSave, onCancel }: { initial: BaseMapSource; taken: string[]; onSave: (s: BaseMapSource) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [s, setS] = useState<BaseMapSource>(initial);
  const up = (patch: Partial<BaseMapSource>) => setS((x) => ({ ...x, ...patch }));
  const terrainTypes: BaseMapSource["type"][] = ["terrarium", "quantized-mesh"];
  const types: BaseMapSource["type"][] = s.kind === "terrain" ? terrainTypes : ["xyz", "tms", "wmts"];
  const id = s.id || s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const clash = taken.includes(id);
  const field = "flex flex-col gap-1 text-[12px] text-fg3";
  return (
    <form
      className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-line bg-s2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = Object.fromEntries(Object.entries({ ...s, id }).filter(([, v]) => v !== "" && v !== undefined)) as unknown as BaseMapSource;
        void onSave(clean);
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className={cx(field, "min-w-48 flex-1")}>
          {t("admin.pickerName")}
          <input className="input" required value={s.label} onChange={(e) => up({ label: e.target.value })} />
        </label>
        <label className={field}>
          {t("admin.kind")}
          <select className="input" value={s.kind} onChange={(e) => up({ kind: e.target.value as BaseMapSource["kind"], type: e.target.value === "terrain" ? "terrarium" : "xyz" })}>
            <option value="imagery">{t("admin.imagery")}</option>
            <option value="terrain">{t("admin.terrain")}</option>
          </select>
        </label>
        <label className={field}>
          {t("admin.type")}
          <select className="input" value={s.type} onChange={(e) => up({ type: e.target.value as BaseMapSource["type"] })}>
            {types.map((ty) => (
              <option key={ty} value={ty}>
                {t(TYPE_LABEL[ty])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={field}>
        {t("admin.address")}
        <input className="input" dir="ltr" required value={s.url} placeholder={t(URL_HINT[s.type])} onChange={(e) => up({ url: e.target.value })} />
      </label>
      {s.type === "wmts" && (
        <div className="flex flex-wrap gap-3">
          <label className={cx(field, "flex-1")}>
            {t("admin.layer")}
            <input className="input" dir="ltr" required value={s.layer ?? ""} onChange={(e) => up({ layer: e.target.value })} />
          </label>
          <label className={cx(field, "flex-1")}>
            {t("admin.matrixSet")}
            <input className="input" dir="ltr" value={s.matrixSet ?? ""} placeholder="GoogleMapsCompatible" translate="no" onChange={(e) => up({ matrixSet: e.target.value })} />
          </label>
          <label className={cx(field, "flex-1")}>
            {t("admin.format")}
            <input className="input" dir="ltr" value={s.format ?? ""} placeholder="image/jpeg" translate="no" onChange={(e) => up({ format: e.target.value })} />
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className={cx(field, "w-32")}>
          {t("admin.maxZoom")}
          <input className="input" type="number" min={0} max={30} value={s.maxZoom ?? ""} onChange={(e) => up({ maxZoom: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
        <label className={cx(field, "flex-1")}>
          {t("admin.credit")}
          <input className="input" value={s.attribution ?? ""} onChange={(e) => up({ attribution: e.target.value })} />
        </label>
      </div>
      {clash && <p className="text-[12px] text-[var(--bad)]">{t("admin.nameTaken")}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!s.label || !s.url || clash}>
          <Check size={14} /> {t("admin.saveSource")}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t("admin.cancel")}
        </button>
      </div>
    </form>
  );
}

// ---- Storage ----

function StorageTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [gb, setGb] = useState("");
  const load = () =>
    api
      .storage()
      .then((i) => {
        setInfo(i);
        setGb(i.quotaBytes == null ? "" : String(+(i.quotaBytes / 1024 ** 3).toFixed(2)));
      })
      .catch(fail);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!info) return <p className="text-fg3">{t("admin.loading")}</p>;
  const cap = info.quotaBytes ?? info.disk?.totalBytes ?? null;
  const share = cap ? Math.min(1, info.usedBytes / cap) : 0;
  return (
    <>
      <H note={t("admin.storageNote")}>{t("admin.storage")}</H>
      <div className="mb-5 max-w-2xl rounded-[10px] border border-line bg-s2 p-4">
        <div className="mb-2 flex items-baseline gap-2">
          <HardDrive size={16} className="text-fg3" />
          <span className="num text-[20px] font-semibold">{fmtBytes(info.usedBytes)}</span>
          <span className="text-fg3">{info.quotaBytes != null ? t("admin.usedOfQuota", { quota: fmtBytes(info.quotaBytes) }) : t("admin.usedNoQuota")}</span>
        </div>
        {cap && (
          <div className="h-2 overflow-hidden rounded-full bg-s3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t("admin.storageUsed")}>
            <div className={cx("h-full rounded-full", share > 0.9 ? "bg-[var(--bad)]" : "bg-accent")} style={{ width: `${Math.max(share * 100, 1)}%` }} />
          </div>
        )}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="text-fg3">{t("admin.published")}</dt>
          <dd className="num">
            {t("admin.publishedValue", { bytes: fmtBytes(info.publishedBytes), versions: t("admin.versions", { count: info.versions }), models: t("admin.models", { count: info.models }) })}
          </dd>
          <dt className="text-fg3">{t("admin.uploading")}</dt>
          <dd className="num">{fmtBytes(info.uploadingBytes)}</dd>
          {info.disk && (
            <>
              <dt className="text-fg3">{t("admin.disk")}</dt>
              <dd className="num">
                {t("admin.diskValue", { free: fmtBytes(info.disk.freeBytes), total: fmtBytes(info.disk.totalBytes) })}
              </dd>
            </>
          )}
        </dl>
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.setQuota(gb.trim() === "" ? null : Math.round(Number(gb) * 1024 ** 3));
            await load();
          } catch (err) {
            fail(err);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.quotaGb")}
          <input className="input !w-40" type="number" min={0} step="any" value={gb} onChange={(e) => setGb(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary">
          {t("admin.saveQuota")}
        </button>
      </form>
    </>
  );
}

// ---- Permanent delete ----

function DeleteTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const models = useApp((s) => s.serverModels);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const shown = models.filter((m) => !q || `${m.name} ${m.project} ${m.operation}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  const m = models.find((x) => x.id === pick);
  return (
    <>
      <H note={t("admin.deleteNote")}>{t("admin.deleteTitle")}</H>
      {done && <p className="mb-3 text-[12px] text-fg2">{done}</p>}
      <input className="input mb-2 max-w-md" placeholder={t("admin.findModel")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("admin.findModel")} />
      <ul className="mb-4 max-h-64 max-w-2xl overflow-auto rounded-[10px] border border-line scrollbar-thin">
        {shown.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => (setPick(x.id), setTyped(""))}
              className={cx("flex w-full items-center gap-2 border-b border-line px-3 py-2 text-start last:border-b-0", pick === x.id ? "bg-accent-soft" : "hover:bg-s3")}
            >
              <span className="min-w-0 flex-1 truncate font-medium" dir="auto" data-content>{x.name}</span>
              <span className="num text-[11px] text-fg3">
                v{x.version} · {fmtBytes(x.sizeBytes)}
              </span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-fg3">{t("admin.noModels")}</li>}
      </ul>
      {m && (
        <form
          className="max-w-2xl rounded-[10px] border border-[var(--bad)]/50 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.deleteModel(m.id, typed);
              setPick(null);
              setTyped("");
              setDone(t("admin.deleted", { name: r.name, versions: t("admin.versions", { count: r.versions }), bytes: fmtBytes(r.bytes) }));
              await refreshLibrary();
            } catch (err) {
              fail(err);
            }
          }}
        >
          <p className="mb-2 text-fg2">
            <Trans i18nKey="admin.typeToDelete" values={{ versions: t("admin.versions", { count: m.versions }) }} components={{ name: <strong className="select-all text-fg">{m.name}</strong> }} />
          </p>
          <div className="flex gap-2">
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("admin.confirmName")} autoComplete="off" />
            <button type="submit" className="btn-primary !bg-[var(--bad)]" disabled={typed.trim() !== m.name.trim()}>
              <Trash2 size={14} /> {t("admin.deleteForGood")}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

// ---- Audit log ----

function AuditTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [check, setCheck] = useState<string | null>(null);
  const [chainBroken, setChainBroken] = useState(false);
  const filter = () => ({ action: action || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(new Date(to).getTime() + 86_400_000).toISOString() : undefined });
  const load = () => api.audit({ ...filter(), limit: 500 }).then(setRows).catch(fail);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const actions = useMemo(() => [...new Set((rows ?? []).map((r) => r.action))].sort(), [rows]);
  return (
    <>
      <H note={t("admin.auditNote")}>{t("admin.auditTitle")}</H>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.action")}
          <input className="input !w-48" list="audit-actions" value={action} onChange={(e) => setAction(e.target.value)} placeholder={t("admin.all")} dir="ltr" />
          <datalist id="audit-actions">
            {actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.from")}
          <input className="input !w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.to")}
          <input className="input !w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="btn-primary" onClick={() => void load()}>
          {t("admin.show")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            try {
              saveText(`viewer-audit-${new Date().toISOString().slice(0, 10)}.csv`, await api.auditCsv(filter()));
            } catch (e) {
              fail(e);
            }
          }}
        >
          <Download size={14} /> {t("admin.exportCsv")}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              const v = await api.verifyAudit();
              setCheck(v.ok ? t("admin.chainOk", { count: v.count }) : t("admin.chainBroken", { n: v.brokenAt }));
              setChainBroken(!v.ok);
            } catch (e) {
              fail(e);
            }
          }}
        >
          <ShieldCheck size={14} /> {t("admin.checkChain")}
        </button>
      </div>
      {check && <p className={cx("mb-3 text-[12px]", chainBroken ? "text-[var(--bad)]" : "text-fg2")}>{check}</p>}
      {/* A wide table scrolls sideways: the keyboard can reach it to scroll (WCAG 2.1.1). */}
      <div role="region" tabIndex={0} aria-label={t("admin.tabs.audit")} className="overflow-x-auto rounded-[10px] border border-line">
        <table className="w-full text-[12px]">
          <thead className="bg-s2 text-start text-fg3">
            <tr>
              {["#", t("admin.cols.time"), t("admin.cols.action"), t("admin.cols.target"), t("admin.cols.address"), t("admin.cols.workstation"), t("admin.cols.detail")].map((h) => (
                <th key={h} className="px-2 py-1.5 text-start font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.seq} className="border-t border-line align-top" data-content>
                <td className="num px-2 py-1 text-fg3">{r.seq}</td>
                <td className="num whitespace-nowrap px-2 py-1">{new Date(r.at).toLocaleString()}</td>
                <td className="whitespace-nowrap px-2 py-1 font-mono" dir="ltr">
                  {r.action}
                </td>
                <td className="max-w-40 truncate px-2 py-1" dir="ltr" title={r.target}>
                  {r.target}
                </td>
                <td className="num px-2 py-1" dir="ltr">
                  {r.ip}
                </td>
                <td className="px-2 py-1" dir="ltr">
                  {r.host}
                </td>
                <td className="max-w-80 truncate px-2 py-1 font-mono text-fg3" dir="ltr" title={JSON.stringify(r.detail)}>
                  {Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}
                </td>
              </tr>
            ))}
            {rows && !rows.length && (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-fg3">
                  {t("admin.nothing")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 500 && <p className="mt-2 text-[11px] text-fg3">{t("admin.latest500")}</p>}
    </>
  );
}

// ---- Password ----

function PasswordTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const short = next.length > 0 && next.length < 12;
  const differ = again.length > 0 && again !== next;
  return (
    <>
      <H note={t("admin.passwordNote")}>{t("admin.password")}</H>
      {done && <p className="mb-3 text-[12px] text-fg2">{t("admin.changed")}</p>}
      <form
        className="flex max-w-sm flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.changePassword(current, next);
            setDone(true);
            setCurrent("");
            setNext("");
            setAgain("");
          } catch (err) {
            fail(err);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.current")}
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.new")}
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {short && <span className="text-[var(--bad)]">{t("admin.moreChars", { n: 12 - next.length })}</span>}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          {t("admin.again")}
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {differ && <span className="text-[var(--bad)]">{t("admin.noMatch")}</span>}
        </label>
        <button type="submit" className="btn-primary justify-center" disabled={!current || next.length < 12 || next !== again}>
          {t("admin.change")}
        </button>
      </form>
    </>
  );
}
