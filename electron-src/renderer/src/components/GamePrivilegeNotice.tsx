import { useEffect, useState } from "react";
import { GAME_PRIVILEGE_WARNING_CHANNEL, type GamePrivilegeWarning } from "../../../shared/game_privileges";
import { useTranslation } from "../i18n";

export function GamePrivilegeNotice() {
  const t = useTranslation();
  const [warning, setWarning] = useState<GamePrivilegeWarning | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const off = window.ipcRenderer.on(GAME_PRIVILEGE_WARNING_CHANNEL, (_event, value) => {
      revision += 1;
      setWarning(value as GamePrivilegeWarning | null);
      setRestartError(false);
    });
    const initialRevision = revision;
    void window.ipcRenderer.invoke<GamePrivilegeWarning | null>("game-privileges.getWarning")
      .then(value => { if (!disposed && revision === initialRevision) setWarning(value ?? null); })
      .catch(() => {});
    return () => { disposed = true; off(); };
  }, []);

  if (!warning) return null;

  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartError(false);
    try {
      await window.ipcRenderer.invoke("game-privileges.restartAsAdmin", warning.id);
    } catch { setRestartError(true); }
    finally { setRestarting(false); }
  };

  return (
    <aside className="game-privilege-notice" role="alert" aria-labelledby="game-privilege-title">
      <div className="game-privilege-notice__body">
        <strong id="game-privilege-title">{t("gamePrivileges.title", { game: warning.exeName })}</strong>
        <p>{t("gamePrivileges.description")}</p>
        {restartError ? <p>{t("gamePrivileges.restartError")}</p> : null}
      </div>
      <div className="game-privilege-notice__actions">
        <button type="button" disabled={restarting} onClick={() => void restart()}>
          {t(restarting ? "gamePrivileges.restarting" : "gamePrivileges.restart")}
        </button>
        <button type="button" className="secondary" disabled={restarting} onClick={() => {
          void window.ipcRenderer.invoke("game-privileges.dismiss", warning.id).catch(() => {});
        }}>
          {t("gamePrivileges.dismiss")}
        </button>
      </div>
    </aside>
  );
}
