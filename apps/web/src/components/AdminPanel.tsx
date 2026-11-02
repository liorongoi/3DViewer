import { useEffect, useMemo, useState } from "react";
import { BASE_MAPS, TERRAINS, fmtBytes } from "@viewer/core";
import type { BaseMapConfig, BaseMapSource, ClassificationLevel } from "@viewer/shared";
import { useEngine } from "../engine";
import { saveText } from "../download";
import { getBaseMaps, listLevels } from "../server/api";
import { AdminApi, type AuditEntry, type StorageInfo } from "../server/admin-api";
import { refreshLibrary } from "../state/library";
import { useApp } from "../state/store";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Download, HardDrive, Layers, Lock, Map, Plus, ShieldCheck, Trash2, X } from "./icons";
import { IconButton, cx } from "./primitives";

/**
 * Admin page (WP 3.9, UI design 3.5): password sign-in, then classification levels, base map
 * sources, storage quota, permanent delete, the audit log and the password itself.
 */
type Tab = "levels" | "basemaps" | "storage" | "delete" | "audit" | "password";
const TABS: { id: Tab; label: string }[] = [
  { id: "levels", label: "Classification levels" },
  { id: "basemaps", label: "Base maps" },
  { id: "storage", label: "Storage" },
  { id: "delete", label: "Delete models" },
  { id: "audit", label: "Audit log" },
  { id: "password", label: "Password" },
];

export function AdminPanel() {
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ adminOpen: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, set]);

  if (!open) return null;
  const close = () => set({ adminOpen: false });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
      <div role="dialog" aria-label="Administration" className="glass flex h-[min(760px,92vh)] w-[min(1040px,96vw)] flex-col rounded-[16px]">
        <header className="flex h-14 items-center gap-3 border-b border-line px-5">
          <ShieldCheck size={18} className="text-accent" />
          <h2 className="flex-1 text-[15px] font-semibold">Administration</h2>
          {state === "signed-in" && (
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await api!.logout();
                setState("signed-out");
              }}
            >
              Sign out
            </button>
          )}
          <IconButton size="sm" label="Close" onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        {!api ? (
          <Centre>
            <p className="text-fg2">The admin page needs the VIEWER server. This copy of the app is running on its sample library.</p>
          </Centre>
        ) : state === "loading" ? (
          <Centre>
            <p className="text-fg3">Checking…</p>
          </Centre>
        ) : state === "no-password" ? (
          <Centre>
            <Lock size={22} className="text-fg3" />
            <p className="max-w-md text-center text-fg2">
              No admin password is set yet. The person who runs the server sets <code dir="ltr">ADMIN_PASSWORD</code> (12 characters or more) and restarts it.
            </p>
          </Centre>
        ) : state === "signed-out" ? (
          <SignIn api={api} onDone={() => setState("signed-in")} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-e border-line p-2" aria-label="Admin sections">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-current={tab === t.id ? "page" : undefined}
                  onClick={() => setTab(t.id)}
                  className={cx("h-9 rounded-[8px] px-3 text-start", tab === t.id ? "bg-accent-soft text-fg" : "text-fg2 hover:bg-s3")}
                >
                  {t.label}
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
  const [error, setError] = useState<string | null>(null);
  const fail: Fail = (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/sign in as administrator/i.test(msg)) return onSignedOut();
    setError(msg);
  };
  return (
    <>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-[10px] border border-[var(--bad)]/40 p-3 text-[13px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--bad)]" />
          <p className="flex-1 text-fg2">{error}</p>
          <IconButton size="sm" label="Dismiss" onClick={() => setError(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {children(fail)}
    </>
  );
}

function SignIn({ api, onDone }: { api: AdminApi; onDone: () => void }) {
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centre>
      <form onSubmit={submit} className="flex w-80 flex-col gap-3">
        <Lock size={22} className="self-center text-fg3" />
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          Admin password
          <input type="password" autoFocus autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="text-[12px] text-[var(--bad)]">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary justify-center" disabled={!password || busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-center text-[11px] text-fg3">Every sign-in, and every wrong password, is recorded in the audit log.</p>
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
      <H note="The banner at the top and bottom of the viewer, the library cards, thumbnails and screenshots all use these. Lowest level first; the globe on its own shows the first one. Text must have a contrast of at least 4.5:1 on the band.">
        Classification levels
      </H>
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
                setNote(r.thumbnailsQueued ? `Saved. ${r.thumbnailsQueued} thumbnail${r.thumbnailsQueued === 1 ? " is" : "s are"} being drawn again with the new band.` : "Saved.");
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
                setNote(`Removed ${l.label}.`);
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
                fail(new Error(`A level called "${next.label}" already exists.`));
                return false;
              }
              try {
                await api.saveLevel({ ...next, id });
                await reloadLevels(api);
                setAdding(false);
                setNote(`Added ${next.label}.`);
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
          <Plus size={14} /> Add a level
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
        {label || "Level name"}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-[12px] text-fg3">
          Name on the banner
          <input className="input" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <ColourField label="Band" value={color} onChange={setColor} />
        <ColourField label="Text" value={text} onChange={setText} />
        <span className={cx("num w-24 pb-2 text-[12px]", ratio >= 4.5 ? "text-fg2" : "text-[var(--bad)]")} title="WCAG contrast of the text on the band; 4.5:1 or more is needed">
          {valid ? `${ratio.toFixed(1)}:1 ${ratio >= 4.5 ? "readable" : "too low"}` : "—"}
        </span>
        <div className="ms-auto flex items-center gap-1 pb-0.5">
          {!isNew && (
            <>
              <IconButton size="sm" label="Move down a level" disabled={props.first} onClick={props.onUp}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton size="sm" label="Move up a level" disabled={props.last} onClick={props.onDown}>
                <ArrowDown size={14} />
              </IconButton>
            </>
          )}
          <button type="button" className="btn-primary" disabled={!valid || ratio < 4.5 || !changed} onClick={() => void props.onSave({ ...l, label: label.trim(), color: color.toUpperCase(), textColor: text.toUpperCase() })}>
            <Check size={14} /> {isNew ? "Add" : "Save"}
          </button>
          {isNew ? (
            <button type="button" className="btn-ghost" onClick={props.onCancel}>
              Cancel
            </button>
          ) : confirm ? (
            <>
              <button type="button" className="btn-ghost text-[var(--bad)]" onClick={() => (setConfirm(false), props.onRemove?.())}>
                Remove for good
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <IconButton size="sm" label="Remove this level" onClick={() => setConfirm(true)}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
    </li>
  );
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-fg3">
      {label}
      <span className="flex items-center gap-1">
        <input type="color" aria-label={`${label} colour picker`} value={isHex(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-9 cursor-pointer rounded-[6px] border border-line bg-transparent" />
        <input dir="ltr" className="input !w-24 font-mono uppercase" value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} aria-label={`${label} colour, hex`} />
      </span>
    </label>
  );
}

// ---- Base maps ----

const TYPE_LABEL: Record<BaseMapSource["type"], string> = {
  xyz: "XYZ tiles",
  tms: "TMS",
  wmts: "WMTS",
  terrarium: "Terrarium heights (PNG)",
  "quantized-mesh": "Quantized-mesh",
};
const URL_HINT: Record<BaseMapSource["type"], string> = {
  xyz: "https://maps.internal/ortho/{z}/{x}/{y}.jpg  or  /basemap/ortho/{z}/{x}/{y}.jpg",
  tms: "https://maps.internal/tms/ortho",
  wmts: "https://maps.internal/wmts/1.0.0/WMTSCapabilities.xml",
  terrarium: "https://maps.internal/terrain/{z}/{x}/{y}.png",
  "quantized-mesh": "https://maps.internal/terrain  (folder with layer.json)",
};

function BaseMapsTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const engine = useEngine();
  const [cfg, setCfg] = useState<BaseMapConfig | null>(null);
  const [draft, setDraft] = useState<BaseMapSource | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    void getBaseMaps(api.srv).then(setCfg).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!cfg) return <p className="text-fg3">Loading…</p>;

  const save = async (next: BaseMapConfig) => {
    const before = cfg;
    setCfg(next);
    try {
      const r = await api.saveBaseMaps(next);
      setCfg(r);
      const problems = (await engine?.useSiteBaseMaps(r, api.srv.base)) ?? [];
      setSaved(problems.length ? `Saved, but the viewer could not open: ${problems.join(" ")}` : "Saved. Every viewer that opens from now on gets these sources.");
    } catch (e) {
      setCfg(before);
      fail(e);
    }
  };
  const imagery = [...cfg.sources.filter((s) => s.kind === "imagery").map((s) => ({ id: s.id, label: s.label })), ...BASE_MAPS.filter((b) => !(cfg.hideOnline && b.online)).map((b) => ({ id: b.id, label: b.label }))];
  const terrain = [...cfg.sources.filter((s) => s.kind === "terrain").map((s) => ({ id: s.id, label: s.label })), ...TERRAINS.filter((t) => !(cfg.hideOnline && t.online)).map((t) => ({ id: t.id, label: t.label }))];

  return (
    <>
      <H note="Point the viewer at this site's own map servers or the base map package (RND-11). A path that starts with / is on this server. The viewer works with none of them; the bundled world map is always there.">Base maps and terrain</H>
      {saved && <p className="mb-3 text-[12px] text-fg2">{saved}</p>}
      <ul className="mb-3 flex flex-col gap-1.5">
        {cfg.sources.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-[8px] border border-line bg-s2 px-3 py-2">
            {s.kind === "imagery" ? <Map size={14} className="text-fg3" /> : <Layers size={14} className="text-fg3" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{s.label}</span>
              <span className="block truncate text-[11px] text-fg3" dir="ltr">
                {TYPE_LABEL[s.type]} · {s.url}
                {s.layer ? ` · ${s.layer}` : ""}
              </span>
            </span>
            <button type="button" className="btn-ghost h-7" onClick={() => setDraft(s)}>
              Edit
            </button>
            <IconButton size="sm" label={`Remove ${s.label}`} onClick={() => void save({ ...cfg, sources: cfg.sources.filter((x) => x.id !== s.id) })}>
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
        {!cfg.sources.length && <li className="text-[12px] text-fg3">No site sources yet. The viewer offers its built-in list.</li>}
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
          <Plus size={14} /> Add a source
        </button>
      )}

      <div className="mt-6 grid max-w-2xl grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <span className="text-fg2">Opens with</span>
        <select className="input" value={cfg.defaultImagery ?? ""} onChange={(e) => void save({ ...cfg, defaultImagery: e.target.value || undefined })} aria-label="Base map the viewer opens with">
          <option value="">The viewer's own choice</option>
          {imagery.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-fg2">Terrain</span>
        <select className="input" value={cfg.defaultTerrain ?? ""} onChange={(e) => void save({ ...cfg, defaultTerrain: e.target.value || undefined })} aria-label="Terrain the viewer opens with">
          <option value="">The viewer's own choice</option>
          {terrain.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span />
        <label className="flex items-center gap-2 text-fg2">
          <input type="checkbox" checked={!!cfg.hideOnline} onChange={(e) => void save({ ...cfg, hideOnline: e.target.checked })} className="accent-[var(--accent)]" />
          Hide the internet sources (Esri, OpenStreetMap, Sentinel-2 cloudless, AWS terrain)
        </label>
      </div>
    </>
  );
}

function SourceForm({ initial, taken, onSave, onCancel }: { initial: BaseMapSource; taken: string[]; onSave: (s: BaseMapSource) => Promise<void>; onCancel: () => void }) {
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
          Name in the picker
          <input className="input" required value={s.label} onChange={(e) => up({ label: e.target.value })} />
        </label>
        <label className={field}>
          Kind
          <select className="input" value={s.kind} onChange={(e) => up({ kind: e.target.value as BaseMapSource["kind"], type: e.target.value === "terrain" ? "terrarium" : "xyz" })}>
            <option value="imagery">Imagery</option>
            <option value="terrain">Terrain</option>
          </select>
        </label>
        <label className={field}>
          Type
          <select className="input" value={s.type} onChange={(e) => up({ type: e.target.value as BaseMapSource["type"] })}>
            {types.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={field}>
        Address
        <input className="input" dir="ltr" required value={s.url} placeholder={URL_HINT[s.type]} onChange={(e) => up({ url: e.target.value })} />
      </label>
      {s.type === "wmts" && (
        <div className="flex flex-wrap gap-3">
          <label className={cx(field, "flex-1")}>
            Layer
            <input className="input" dir="ltr" required value={s.layer ?? ""} onChange={(e) => up({ layer: e.target.value })} />
          </label>
          <label className={cx(field, "flex-1")}>
            Matrix set
            <input className="input" dir="ltr" value={s.matrixSet ?? ""} placeholder="GoogleMapsCompatible" onChange={(e) => up({ matrixSet: e.target.value })} />
          </label>
          <label className={cx(field, "flex-1")}>
            Format
            <input className="input" dir="ltr" value={s.format ?? ""} placeholder="image/jpeg" onChange={(e) => up({ format: e.target.value })} />
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className={cx(field, "w-32")}>
          Deepest zoom
          <input className="input" type="number" min={0} max={30} value={s.maxZoom ?? ""} onChange={(e) => up({ maxZoom: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
        <label className={cx(field, "flex-1")}>
          Credit shown on the map
          <input className="input" value={s.attribution ?? ""} onChange={(e) => up({ attribution: e.target.value })} />
        </label>
      </div>
      {clash && <p className="text-[12px] text-[var(--bad)]">Another source already has this name.</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!s.label || !s.url || clash}>
          <Check size={14} /> Save source
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- Storage ----

function StorageTab({ api, fail }: { api: AdminApi; fail: Fail }) {
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
  if (!info) return <p className="text-fg3">Loading…</p>;
  const cap = info.quotaBytes ?? info.disk?.totalBytes ?? null;
  const share = cap ? Math.min(1, info.usedBytes / cap) : 0;
  return (
    <>
      <H note="The quota counts every published version and the uploads still in progress. An upload that would go past it is refused with a message that names the administrator.">Storage</H>
      <div className="mb-5 max-w-2xl rounded-[10px] border border-line bg-s2 p-4">
        <div className="mb-2 flex items-baseline gap-2">
          <HardDrive size={16} className="text-fg3" />
          <span className="num text-[20px] font-semibold">{fmtBytes(info.usedBytes)}</span>
          <span className="text-fg3">used{info.quotaBytes != null ? ` of ${fmtBytes(info.quotaBytes)} quota` : ", no quota"}</span>
        </div>
        {cap && (
          <div className="h-2 overflow-hidden rounded-full bg-s3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label="Storage used">
            <div className={cx("h-full rounded-full", share > 0.9 ? "bg-[var(--bad)]" : "bg-accent")} style={{ width: `${Math.max(share * 100, 1)}%` }} />
          </div>
        )}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="text-fg3">Published</dt>
          <dd className="num">
            {fmtBytes(info.publishedBytes)} in {info.versions} version{info.versions === 1 ? "" : "s"} of {info.models} model{info.models === 1 ? "" : "s"}
          </dd>
          <dt className="text-fg3">Uploading</dt>
          <dd className="num">{fmtBytes(info.uploadingBytes)}</dd>
          {info.disk && (
            <>
              <dt className="text-fg3">Disk</dt>
              <dd className="num">
                {fmtBytes(info.disk.freeBytes)} free of {fmtBytes(info.disk.totalBytes)}
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
          Quota in GB (empty for none)
          <input className="input !w-40" type="number" min={0} step="any" value={gb} onChange={(e) => setGb(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary">
          Save quota
        </button>
      </form>
    </>
  );
}

// ---- Permanent delete ----

function DeleteTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const models = useApp((s) => s.serverModels);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const shown = models.filter((m) => !q || `${m.name} ${m.project} ${m.operation}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  const m = models.find((x) => x.id === pick);
  return (
    <>
      <H note="Deleting removes the model, every version and all of its files from the server. It cannot be undone. The audit log keeps the record of the model and of this delete.">Delete models for good</H>
      {done && <p className="mb-3 text-[12px] text-fg2">{done}</p>}
      <input className="input mb-2 max-w-md" placeholder="Find a model" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a model" />
      <ul className="mb-4 max-h-64 max-w-2xl overflow-auto rounded-[10px] border border-line scrollbar-thin">
        {shown.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              onClick={() => (setPick(x.id), setTyped(""))}
              className={cx("flex w-full items-center gap-2 border-b border-line px-3 py-2 text-start last:border-b-0", pick === x.id ? "bg-accent-soft" : "hover:bg-s3")}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{x.name}</span>
              <span className="num text-[11px] text-fg3">
                v{x.version} · {fmtBytes(x.sizeBytes)}
              </span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-fg3">No models.</li>}
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
              setDone(`Deleted ${r.name}: ${r.versions} version${r.versions === 1 ? "" : "s"}, ${fmtBytes(r.bytes)}.`);
              await refreshLibrary();
            } catch (err) {
              fail(err);
            }
          }}
        >
          <p className="mb-2 text-fg2">
            Type <strong className="select-all text-fg">{m.name}</strong> to delete it and its {m.versions} version{m.versions === 1 ? "" : "s"}.
          </p>
          <div className="flex gap-2">
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Model name to confirm" autoComplete="off" />
            <button type="submit" className="btn-primary !bg-[var(--bad)]" disabled={typed.trim() !== m.name.trim()}>
              <Trash2 size={14} /> Delete for good
            </button>
          </div>
        </form>
      )}
    </>
  );
}

// ---- Audit log ----

function AuditTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [check, setCheck] = useState<string | null>(null);
  const filter = () => ({ action: action || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(new Date(to).getTime() + 86_400_000).toISOString() : undefined });
  const load = () => api.audit({ ...filter(), limit: 500 }).then(setRows).catch(fail);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const actions = useMemo(() => [...new Set((rows ?? []).map((r) => r.action))].sort(), [rows]);
  return (
    <>
      <H note="Every view, upload, change, sign-in and delete, with the address and workstation it came from. Each entry carries a hash of the one before, so an edited entry shows.">Audit log</H>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          Action
          <input className="input !w-48" list="audit-actions" value={action} onChange={(e) => setAction(e.target.value)} placeholder="All" dir="ltr" />
          <datalist id="audit-actions">
            {actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          From
          <input className="input !w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          To
          <input className="input !w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="btn-primary" onClick={() => void load()}>
          Show
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
          <Download size={14} /> Export CSV
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            try {
              const v = await api.verifyAudit();
              setCheck(v.ok ? `All ${v.count} entries check out.` : `Entry ${v.brokenAt} does not match its hash: the log was changed from there on.`);
            } catch (e) {
              fail(e);
            }
          }}
        >
          <ShieldCheck size={14} /> Check the chain
        </button>
      </div>
      {check && <p className={cx("mb-3 text-[12px]", /does not match/.test(check) ? "text-[var(--bad)]" : "text-fg2")}>{check}</p>}
      <div className="overflow-x-auto rounded-[10px] border border-line">
        <table className="w-full text-[12px]">
          <thead className="bg-s2 text-start text-fg3">
            <tr>
              {["#", "Time", "Action", "Target", "Address", "Workstation", "Detail"].map((h) => (
                <th key={h} className="px-2 py-1.5 text-start font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.seq} className="border-t border-line align-top">
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
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 500 && <p className="mt-2 text-[11px] text-fg3">Showing the latest 500. Narrow the dates or export the CSV for the rest.</p>}
    </>
  );
}

// ---- Password ----

function PasswordTab({ api, fail }: { api: AdminApi; fail: Fail }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const short = next.length > 0 && next.length < 12;
  const differ = again.length > 0 && again !== next;
  return (
    <>
      <H note="At least 12 characters. Changing it signs out every other admin session. If it is lost, the person who runs the server can set a new one with ADMIN_PASSWORD and ADMIN_PASSWORD_RESET=1.">Admin password</H>
      {done && <p className="mb-3 text-[12px] text-fg2">Password changed. Other sessions are signed out.</p>}
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
          Current password
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          New password
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {short && <span className="text-[var(--bad)]">{12 - next.length} more characters needed.</span>}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg3">
          New password again
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {differ && <span className="text-[var(--bad)]">The two do not match.</span>}
        </label>
        <button type="submit" className="btn-primary justify-center" disabled={!current || next.length < 12 || next !== again}>
          Change password
        </button>
      </form>
    </>
  );
}
