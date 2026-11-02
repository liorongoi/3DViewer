import { useRef, useState } from "react";
import { BASE_MAPS, TERRAINS, type UserLayer, type WmtsLayerInfo, type WmsLayerInfo } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { ChevronDown, Eye, EyeOff, Focus, Globe, Map, Mountain, Trash2, Upload, X } from "./icons";
import { IconButton, Segmented, cx } from "./primitives";

/**
 * Left panel "Map" tab: base map, terrain, and the user's own layers
 * (VWR-GEO-01, VWR-DAT-01; plan WP 1.6 and 1.9).
 */
export function MapTab() {
  return (
    <div className="flex flex-col gap-3 p-2">
      <BasePicker />
      <TerrainPicker />
      <UserData />
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Map; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg3">
        <Icon size={13} /> {title}
      </h3>
      {children}
    </section>
  );
}

function Choice({ checked, label, note, onSelect }: { checked: boolean; label: string; note?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cx("flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-start", checked ? "bg-accent-soft text-fg" : "hover:bg-s3 text-fg2")}
    >
      <span className={cx("grid h-3.5 w-3.5 place-items-center rounded-full border", checked ? "border-accent" : "border-line-strong")}>
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note && <span className="rounded bg-s3 px-1 text-[10px] uppercase tracking-wide text-fg3">{note}</span>}
    </button>
  );
}

function BasePicker() {
  const engine = useEngine();
  const id = useSignal(engine?.baseMapId, "bundled");
  const users = useSignal(engine?.userLayers.list, []);
  const userBase = users.find((u) => u.asBase);
  return (
    <Section title="Base map" icon={Map}>
      <div role="radiogroup" aria-label="Base map">
        {BASE_MAPS.map((b) => (
          <Choice
            key={b.id}
            checked={!userBase && id === b.id}
            label={b.label.replace(/ \((online|offline)\)$/, "")}
            note={b.online ? "online" : "offline"}
            onSelect={() => {
              if (userBase) engine?.userLayers.setAsBase(userBase.id, false);
              void engine?.setBaseMap(b.id);
            }}
          />
        ))}
        {userBase && <Choice checked label={userBase.name} note="yours" onSelect={() => undefined} />}
      </div>
    </Section>
  );
}

function TerrainPicker() {
  const engine = useEngine();
  const id = useSignal(engine?.terrainId, "none");
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Terrain" icon={Mountain}>
      <div role="radiogroup" aria-label="Terrain" className={cx(busy && "opacity-60")}>
        {TERRAINS.map((t) => (
          <Choice
            key={t.id}
            checked={id === t.id}
            label={t.label.replace(/ \((online|offline)\)$/, "")}
            note={t.id === "none" ? undefined : t.online ? "online" : "offline"}
            onSelect={async () => {
              setBusy(true);
              try {
                await engine?.setTerrain(t.id);
              } finally {
                setBusy(false);
              }
            }}
          />
        ))}
      </div>
      <p className="px-2 pt-1 text-[11px] text-fg3">Models are set on the terrain when it changes, so nothing floats.</p>
    </Section>
  );
}

const SAMPLES: { label: string; files: string[] }[] = [
  { label: "Rivers near Lyon · shapefile in Lambert-93", files: ["lyon-rivers-l93.shp", "lyon-rivers-l93.dbf", "lyon-rivers-l93.prj", "lyon-rivers-l93.cpg"] },
  { label: "Towns of France and Israel · shapefile", files: ["places-fr-il.shp", "places-fr-il.dbf", "places-fr-il.prj", "places-fr-il.cpg"] },
  { label: "Lyon Sentinel-2 · GeoTIFF in UTM 31N", files: ["lyon-s2-utm31.tif"] },
  { label: "Tarn elevation · GeoTIFF, one band", files: ["tarn-dem.tif"] },
];

function UserData() {
  const engine = useEngine();
  const list = useSignal(engine?.userLayers.list, []);
  const input = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [svc, setSvc] = useState(false);

  const add = async (files: File[]) => {
    if (!engine || !files.length) return;
    setBusy(`Reading ${files.length > 1 ? `${files.length} files` : files[0]!.name}…`);
    const r = await engine.userLayers.addFiles(files);
    setErrors(r.errors);
    setBusy(null);
    const top = engine.userLayers.list.get()[0];
    if (r.added && top) engine.userLayers.zoomTo(top.id);
  };

  const addSample = async (s: (typeof SAMPLES)[number]) => {
    setBusy(`Loading ${s.label}…`);
    try {
      const files = await Promise.all(
        s.files.map(async (f) => {
          const res = await fetch(new URL(`samples/user-data/${f}`, document.baseURI));
          if (!res.ok) throw new Error(`${f}: ${res.status}`);
          return new File([await res.blob()], f);
        }),
      );
      await add(files);
    } catch (e) {
      setErrors([String(e)]);
      setBusy(null);
    }
  };

  return (
    <Section title="Your data" icon={Upload}>
      <div
        className={cx("rounded-[10px] border border-dashed p-3 text-center", drag ? "border-accent bg-accent-soft" : "border-line-strong")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void add(Array.from(e.dataTransfer.files));
        }}
      >
        <p className="mb-2 text-[12px] text-fg3">Drop shapefiles (.shp + .dbf + .prj, or a .zip), GeoJSON, KML or GeoTIFF here.</p>
        <div className="flex flex-wrap justify-center gap-1.5">
          <button type="button" className="btn-primary" onClick={() => input.current?.click()}>
            <Upload size={14} /> Add files
          </button>
          <button type="button" className="btn-secondary" onClick={() => setSvc(!svc)} aria-expanded={svc}>
            <Globe size={14} /> Add map service
          </button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".shp,.dbf,.prj,.cpg,.shx,.zip,.geojson,.json,.kml,.kmz,.tif,.tiff"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {svc && <ServiceForm onDone={() => setSvc(false)} onError={(m) => setErrors([m])} />}
      {busy && <p className="px-1 pt-2 text-[12px] text-fg2">{busy}</p>}
      {errors.length > 0 && (
        <div className="mt-2 rounded-[8px] border border-[var(--bad)]/40 p-2 text-[12px]" role="alert">
          {errors.map((e) => (
            <p key={e} className="text-fg2">
              {e}
            </p>
          ))}
          <button type="button" className="mt-1 text-[11px] text-fg3 underline" onClick={() => setErrors([])}>
            Dismiss
          </button>
        </div>
      )}
      {list.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {list.map((l, i) => (
            <UserLayerRow key={l.id} l={l} first={i === 0} last={i === list.length - 1} />
          ))}
        </ul>
      )}
      <details className="mt-2 px-1 text-[12px]">
        <summary className="cursor-pointer text-fg3">Try sample data</summary>
        <div className="mt-1 flex flex-col items-start gap-0.5">
          {SAMPLES.map((s) => (
            <button key={s.label} type="button" className="text-start text-accent hover:underline" onClick={() => void addSample(s)}>
              {s.label}
            </button>
          ))}
          <button
            type="button"
            className="text-start text-accent hover:underline"
            onClick={async () => {
              const layers = await engine!.userLayers.listWmts(new URL("samples/user-data/wmts/WMTSCapabilities.xml", document.baseURI).href);
              const l = engine!.userLayers.addWmts(layers[0]!);
              engine!.userLayers.setAsBase(l.id, true);
            }}
          >
            Offline WMTS · used as the base map
          </button>
        </div>
      </details>
    </Section>
  );
}

function ServiceForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const engine = useEngine();
  const [kind, setKind] = useState<"wmts" | "wms" | "xyz" | "cog">("wmts");
  const [url, setUrl] = useState("");
  const [wmts, setWmts] = useState<WmtsLayerInfo[] | null>(null);
  const [wms, setWms] = useState<{ url: string; layers: WmsLayerInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const hint = {
    wmts: "GetCapabilities address, for example https://server/wmts/1.0.0/WMTSCapabilities.xml",
    wms: "Service address, for example https://server/wms",
    xyz: "Tile address with {z}, {x} and {y}",
    cog: "Address of a GeoTIFF or Cloud Optimised GeoTIFF",
  }[kind];

  const connect = async () => {
    if (!engine || !url) return;
    setBusy(true);
    try {
      if (kind === "wmts") setWmts(await engine.userLayers.listWmts(url));
      else if (kind === "wms") setWms(await engine.userLayers.listWms(url));
      else if (kind === "xyz") {
        engine.userLayers.addXyz(url, new URL(url.replace(/[{}]/g, "")).host);
        onDone();
      } else {
        const l = await engine.userLayers.addGeoTiff(url, decodeURIComponent(url.split("/").pop() ?? "GeoTIFF"));
        engine.userLayers.zoomTo(l.id);
        onDone();
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-[10px] border border-line bg-s2 p-2">
      <div className="mb-2 flex items-center justify-between">
        <Segmented
          label="Service type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setWmts(null);
            setWms(null);
          }}
          options={[
            { value: "wmts", label: "WMTS" },
            { value: "wms", label: "WMS" },
            { value: "xyz", label: "XYZ" },
            { value: "cog", label: "COG" },
          ]}
        />
        <IconButton size="sm" label="Close" onClick={onDone}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="flex gap-1">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void connect()}
          placeholder={hint}
          aria-label={hint}
          dir="ltr"
          className="h-8 min-w-0 flex-1 rounded-[6px] border border-line bg-s1solid px-2 text-[12px] outline-none focus:border-accent"
        />
        <button type="button" className="btn-primary" disabled={!url || busy} onClick={() => void connect()}>
          {busy ? "…" : kind === "wmts" || kind === "wms" ? "Connect" : "Add"}
        </button>
      </div>
      {(wmts || wms) && (
        <ul className="mt-2 max-h-48 overflow-auto scrollbar-thin">
          {wmts?.map((l) => (
            <li key={l.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={l.id}>
                {l.title}
              </span>
              <span className="text-[10px] text-fg3">{l.crs === "other" ? "unsupported grid" : l.matrixSet}</span>
              <button type="button" className="btn-ghost h-7" disabled={l.crs === "other"} onClick={() => engine?.userLayers.addWmts(l)}>
                Add
              </button>
              <button
                type="button"
                className="btn-ghost h-7"
                disabled={l.crs === "other"}
                onClick={() => {
                  const u = engine!.userLayers.addWmts(l);
                  engine!.userLayers.setAsBase(u.id, true);
                }}
              >
                As base
              </button>
            </li>
          ))}
          {wms?.layers.map((l) => (
            <li key={l.name} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={l.name}>
                {l.title}
              </span>
              <button type="button" className="btn-ghost h-7" onClick={() => engine?.userLayers.addWms(wms.url, l.name, l.title, l.bounds)}>
                Add
              </button>
            </li>
          ))}
          {wmts?.length === 0 && <li className="text-fg3">No layers in this service.</li>}
        </ul>
      )}
    </div>
  );
}

function UserLayerRow({ l, first, last }: { l: UserLayer; first: boolean; last: boolean }) {
  const engine = useEngine();
  const u = engine?.userLayers;
  const [open, setOpen] = useState(false);
  return (
    <li className={cx("rounded-[8px] border border-line bg-s2", !l.visible && "opacity-60")}>
      <div className="flex items-center gap-1 p-1">
        <IconButton size="sm" label={l.visible ? "Hide" : "Show"} onClick={() => u?.setVisible(l.id, !l.visible)}>
          {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.kind === "vector" ? l.color : "linear-gradient(135deg,#6a8,#468 60%,#a86)" }} />
        <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="block truncate font-medium">{l.name}</span>
          <span className="block truncate text-[11px] text-fg3">
            {l.source.toUpperCase()} · {l.asBase ? "base map · " : ""}
            {l.info}
          </span>
        </button>
        <IconButton size="sm" label="Zoom to layer" onClick={() => u?.zoomTo(l.id)} disabled={!l.bounds && l.kind === "imagery"}>
          <Focus size={14} />
        </IconButton>
        <IconButton size="sm" label="More" onClick={() => setOpen(!open)}>
          <ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <label className="flex items-center gap-2 text-[12px] text-fg3">
            Opacity
            <input type="range" min={0} max={100} value={Math.round(l.opacity * 100)} onChange={(e) => u?.setOpacity(l.id, Number(e.target.value) / 100)} className="flex-1 accent-[var(--accent)]" />
            <span className="num w-8 text-end text-fg2">{Math.round(l.opacity * 100)}%</span>
          </label>
          <div className="flex flex-wrap gap-1">
            {l.kind === "imagery" && (
              <button type="button" className="btn-ghost h-7" onClick={() => u?.setAsBase(l.id, !l.asBase)}>
                {l.asBase ? "Put back on top" : "Use as base map"}
              </button>
            )}
            <button type="button" className="btn-ghost h-7" disabled={first || l.asBase} onClick={() => u?.move(l.id, 1)}>
              Move up
            </button>
            <button type="button" className="btn-ghost h-7" disabled={last || l.asBase} onClick={() => u?.move(l.id, -1)}>
              Move down
            </button>
            <button type="button" className="btn-ghost h-7 text-[var(--bad)]" onClick={() => u?.remove(l.id)}>
              <Trash2 size={13} /> Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
