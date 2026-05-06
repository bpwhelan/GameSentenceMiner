export type SettingsCatalogOwner = "electron" | "python" | "overlay";

export type SettingsCatalogActionType =
  | "current-tab"
  | "open-gsm-settings"
  | "open-overlay-settings";

export interface SettingsCatalogAction {
  type: SettingsCatalogActionType;
  label: string;
  rootTabKey?: string;
  subtabKey?: string;
}

export interface SettingsCatalogEntry {
  id: string;
  label: string;
  owner: SettingsCatalogOwner;
  keywords: string[];
  shortDescription: string;
  openAction: SettingsCatalogAction;
  notes?: string;
}
