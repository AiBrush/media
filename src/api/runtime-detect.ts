const NON_WEBKIT_UA_TOKEN = /(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPiOS|Firefox|FxiOS)\//;
const WEBKIT_UA_TOKEN = /(?:AppleWebKit|Safari)\//;

export function isLikelyWebKitRuntime(userAgent: string, vendor = ''): boolean {
  return (
    (WEBKIT_UA_TOKEN.test(userAgent) || vendor.startsWith('Apple')) &&
    !NON_WEBKIT_UA_TOKEN.test(userAgent)
  );
}

export function isWebKitRuntime(): boolean {
  const ua =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '';
  const vendor =
    typeof navigator !== 'undefined' && typeof navigator.vendor === 'string'
      ? navigator.vendor
      : '';
  return isLikelyWebKitRuntime(ua, vendor);
}

export function isLikelyFirefoxRuntime(userAgent: string): boolean {
  return /Firefox\//.test(userAgent);
}

export function isFirefoxRuntime(): boolean {
  const ua =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '';
  return isLikelyFirefoxRuntime(ua);
}
