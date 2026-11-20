// The localStorage keys that make up one device's settings, backed up per kind of device
// (src/lib/device-settings.ts). Plain data, so the server can check a backup against it too.
export const DEVICE_SETTING_KEYS = [
  "padsync.rail",
  "padsync.prompts",
  "padsync.gestures",
  "padsync.gestureTuning",
  "padsync.lasso",
  "padsync.tool",
  "padsync.toolSidebar",
  "padsync.panel",
  "padsync.follow",
  "padsync.layoutMode",
  "padsync.layoutIdleMs",
  "padsync.theme",
  "padsync.showCopyButtons",
  "padsync.lecternUrl",
] as const;
export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number];
