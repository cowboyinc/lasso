/**
 * Best-effort update notice: compare the running version against the
 * latest GitHub release. Never throws, never blocks the UI - any
 * failure (offline, rate-limited, bad payload) returns null.
 * Opt out with LASSO_NO_UPDATE_CHECK=1.
 */

const LATEST_RELEASE_URL = "https://api.github.com/repos/cowboyinc/lasso/releases/latest";

/** True when `candidate` is a strictly newer semver than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  if (process.env.LASSO_NO_UPDATE_CHECK) return null;
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    const latest = typeof body.tag_name === "string" ? body.tag_name : null;
    if (latest && isNewerVersion(latest, currentVersion)) {
      return latest.replace(/^v/, "");
    }
    return null;
  } catch {
    return null;
  }
}
