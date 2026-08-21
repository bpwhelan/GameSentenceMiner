import { useTranslation } from "../../i18n";
import type { SaveStatus } from "./hoshidictsSettingsModel";

export function HoshidictsSaveIndicator({
  status
}: {
  status: SaveStatus;
}) {
  const t = useTranslation();
  if (status === "idle") return null;
  const visibleStatus = status === "dirty" ? "saving" : status;
  return (
    <span
      className="hoshidicts-save-status"
      data-status={visibleStatus}
      role="status"
    >
      {t(`settings.hoshidicts.saveStatus.${visibleStatus}`)}
    </span>
  );
}
