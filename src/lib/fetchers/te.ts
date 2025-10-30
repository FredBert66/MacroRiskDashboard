// src/lib/fetchers/te.ts

export const TE_ORIGIN = 'https://api.tradingeconomics.com';

/**
 * Build a URL with encoded query params.
 * We always add `format=json` for consistent payloads.
 */
function buildUrl(path: string, qs: Record<string, string> = {}) {
  const url = new URL(path, TE_ORIGIN);
  Object.entries({ format: 'json', ...qs }).forEach(([k, v]) => url.searchParams.set(k, v));
  return url;
}

/**
 * Fetch TE and robustly parse JSON (detect/handle HTML error pages).
 * Returns parsed JSON (any[] usually). Throws with helpful context/snippet otherwise.
 */
async function fetchAndParseJson(url: URL) {
  const r = await fetch(url, {
    // hint we want JSON; some proxies misbehave without this
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 },
  });

  const text = await r.text();

  // If the server replied with HTML (often login, 401/403/429 proxy page), explain it clearly
  const looksHtml = text.trim().startsWith('<') || text.includes('<!DOCTYPE html');
  if (!r.ok) {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`TE ${url.pathname}${url.search} ${r.status} ${looksHtml ? '(HTML)' : ''} ${snippet}`);
  }

  if (looksHtml) {
    // 200 but HTML => not JSON (TE sometimes serves HTML when credentials are wrong / not authorized)
    throw new Error(`TE ${url.pathname}${url.search} 200 non-JSON (HTML)`);
  }

  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`TE ${url.pathname}${url.search} invalid JSON: ${snippet}`);
  }
}

/**
 * Core TE fetch with credential handling:
 * - Uses TE_USER:TE_KEY when present (unless TE_FORCE_GUEST=1),
 * - On 401/403/429 or non-JSON, falls back to guest:guest (unless TE_DISABLE_GUEST=1).
 */
async function te(path: string, qs: Record<string, string> = {}) {
  const forceGuest = (process.env.TE_FORCE_GUEST ?? '').trim() === '1';
  const disableGuest = (process.env.TE_DISABLE_GUEST ?? '').trim() === '1';
  const user = (process.env.TE_USER ?? '').trim();
  const key = (process.env.TE_KEY ?? '').trim();

  // 1) Try user credentials (unless forced guest)
  if (!forceGuest && user && key) {
    const url = buildUrl(path, { c: `${user}:${key}`, ...qs });
    try {
      return await fetchAndParseJson(url);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // Only fall back on likely auth/plan/proxy issues
      const canFallback =
        !disableGuest && (msg.includes(' 401') || msg.includes(' 403') || msg.includes(' 429') || msg.includes('non-JSON'));
      if (!canFallback) throw e;
      // continue to guest fallback
    }
  }

  // 2) Guest fallback (open but rate-limited)
  if (!disableGuest) {
    const guestUrl = buildUrl(path, { c: 'guest:guest', ...qs });
    return fetchAndParseJson(guestUrl);
  }

  // If guest disabled and primary failed
  throw new Error('TE failed and guest fallback disabled (set TE_DISABLE_GUEST= to allow fallback)');
}

/** ---------------- Convenience wrappers (Indicators API) ----------------
 * Use the stable /indicators endpoint. Country and indicator are passed as query params.
 */
export const tePMI = (country: string) =>
  te('/indicators', { country, indicator: 'PMI' });

export const teUR = (country: string) =>
  te('/indicators', { country, indicator: 'Unemployment Rate' });

export { te };
