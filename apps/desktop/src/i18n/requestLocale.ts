export type DesktopRequestLocale = 'en-US' | 'zh-CN';

let requestLocale: DesktopRequestLocale = 'en-US';

export function getDesktopRequestLocale(): DesktopRequestLocale {
  return requestLocale;
}

export function setDesktopRequestLocale(locale: DesktopRequestLocale): void {
  requestLocale = locale;
}
