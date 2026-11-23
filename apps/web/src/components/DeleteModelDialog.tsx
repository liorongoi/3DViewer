import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { fmtBytes } from "@viewer/core";
import { ServerError, type ModelSummary } from "@viewer/shared";
import { desktop } from "../desktop";
import { AdminApi } from "../server/admin-api";
import { errorText } from "../server/error-text";
import { findModel, refreshLibrary } from "../state/library";
import { useApp } from "../state/store";
import { useOpenModel } from "../useAppEffects";
import { AlertTriangle, Lock, Trash2, X } from "./icons";
import { IconButton } from "./primitives";
import { useDialog } from "./useDialog";

/**
 * Deleting a model from the library, asked first.
 * - A model opened from this computer (or built on it) leaves the library; its files stay, except
 *   that a HOLO build's folder can go to the Recycle Bin with it (desktop app).
 * - A model on the server is deleted for good, with every version and file, as on the admin
 *   page: it needs the admin password and the model's name typed again. The audit log keeps it.
 */
export function DeleteModelDialog() {
  const { t } = useTranslation();
  const id = useApp((s) => s.deleteModelId);
  const set = useApp((s) => s.set);
  const close = () => set({ deleteModelId: null });
  const ref = useDialog<HTMLDivElement>(!!id, { onClose: close });
  const m = id ? findModel(id) : undefined;
  if (!id || !m) return null;
  const local = m.id.startsWith("upload-");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="delete-model-title" className="glass flex w-[min(520px,96vw)] flex-col rounded-[16px]" data-testid="delete-model">
        <header className="flex h-14 items-center gap-3 border-b border-line px-5">
          <Trash2 size={18} className="text-[var(--bad)]" />
          <h2 id="delete-model-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold" dir="auto">
            {t(local ? "deleteModel.titleLocal" : "deleteModel.titleServer", { name: m.name })}
          </h2>
          <IconButton size="sm" label={t("common.close")} onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="p-5">{local ? <LocalDelete m={m} onDone={close} /> : <ServerDelete m={m} onDone={close} />}</div>
      </div>
    </div>
  );
}

/** Closes the model first when it is the one open. */
function useLeaveIfOpen() {
  const { close } = useOpenModel();
  return (id: string) => {
    const s = useApp.getState();
    if (s.route === "viewer" && s.modelId === id) close();
  };
}

function LocalDelete({ m, onDone }: { m: ModelSummary; onDone: () => void }) {
  const { t } = useTranslation();
  const files = useApp((s) => s.uploadFiles[m.id]);
  const leave = useLeaveIfOpen();
  // The HOLO build folder this model came from, when it came from one (desktop app).
  const [folder, setFolder] = useState<string | null>(null);
  const [trash, setTrash] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!files?.length || !desktop?.buildFolderOf) return;
    let live = true;
    void desktop.buildFolderOf(files).then((f) => live && setFolder(f), () => undefined);
    return () => {
      live = false;
    };
  }, [files]);
  const bin = desktop?.platform === "darwin" ? t("deleteModel.trash") : t("deleteModel.recycleBin");

  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      if (folder && trash && files) {
        const ok = await desktop!.trashBuild!(files).catch(() => false);
        if (!ok) {
          setProblem(t("deleteModel.trashFailed", { folder, bin }));
          return;
        }
      }
      leave(m.id);
      useApp.getState().removeUpload(m.id);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <p className="text-[13px] text-fg2">{t("deleteModel.localNote")}</p>
      {folder && (
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={trash} onChange={(e) => setTrash(e.target.checked)} data-testid="delete-model-trash" />
          <span>
            <Trans i18nKey="deleteModel.trashBuild" values={{ bin }} components={{ folder: <strong className="text-fg" dir="auto" data-content>{folder}</strong> }} />
          </span>
        </label>
      )}
      {problem && (
        <p role="alert" className="flex items-start gap-2 text-[12px] text-[var(--bad)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          {t("common.cancel")}
        </button>
        <button type="submit" autoFocus className="btn-primary !bg-[var(--bad)]" disabled={busy} data-testid="delete-model-go">
          <Trash2 size={14} /> {folder && trash ? t("deleteModel.removeAndTrash", { bin }) : t("deleteModel.remove")}
        </button>
      </div>
    </form>
  );
}

function ServerDelete({ m, onDone }: { m: ModelSummary; onDone: () => void }) {
  const { t } = useTranslation();
  const server = useApp((s) => s.server);
  const api = useMemo(() => (server ? new AdminApi(server) : null), [server]);
  const leave = useLeaveIfOpen();
  const [state, setState] = useState<"loading" | "no-password" | "signed-out" | "signed-in">("loading");
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    void api
      .status()
      .then((s) => setState(!s.passwordSet ? "no-password" : s.signedIn ? "signed-in" : "signed-out"))
      .catch(() => setState("signed-out"));
  }, [api]);

  if (!api) return null;
  const nameOk = typed.trim() === m.name.trim();

  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      if (state === "signed-out") {
        await api.login(password);
        setState("signed-in");
        setPassword("");
      }
      await api.deleteModel(m.id, typed);
      leave(m.id);
      await refreshLibrary().catch(() => undefined);
      onDone();
    } catch (e) {
      if (e instanceof ServerError && e.key === "signIn") setState("signed-out");
      setProblem(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <p className="text-[13px] text-fg3">{t("admin.checking")}</p>;
  if (state === "no-password")
    return (
      <div className="grid gap-3 text-[13px] text-fg2">
        <p>{t("deleteModel.serverNote")}</p>
        <p className="flex items-start gap-2">
          <Lock size={14} className="mt-0.5 shrink-0 text-fg3" />
          <span>
            <Trans i18nKey="admin.noPassword" components={{ code: <code dir="ltr" /> }} />
          </span>
        </p>
      </div>
    );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <p className="text-[13px] text-fg2">{t("deleteModel.serverNote")}</p>
      <p className="text-[12px] text-fg3">
        {t("admin.versions", { count: m.versions })} · {fmtBytes(m.sizeBytes)}
      </p>
      {state === "signed-out" && (
        <label className="grid gap-1 text-[12px] text-fg3">
          {t("deleteModel.adminPassword")}
          <input type="password" autoFocus autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="delete-model-password" />
        </label>
      )}
      <label className="grid gap-1 text-[12px] text-fg3">
        <span>
          <Trans i18nKey="admin.typeToDelete" values={{ versions: t("admin.versions", { count: m.versions }) }} components={{ name: <strong className="select-all text-fg" dir="auto">{m.name}</strong> }} />
        </span>
        <input className="input" autoFocus={state === "signed-in"} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("admin.confirmName")} autoComplete="off" data-testid="delete-model-name" />
      </label>
      {problem && (
        <p role="alert" className="flex items-start gap-2 text-[12px] text-[var(--bad)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="btn-primary !bg-[var(--bad)]" disabled={busy || !nameOk || (state === "signed-out" && !password)} data-testid="delete-model-go">
          <Trash2 size={14} /> {t("admin.deleteForGood")}
        </button>
      </div>
      <p className="text-[11px] text-fg3">{t("admin.signInNote")}</p>
    </form>
  );
}
