

export function parseJson(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

export function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  const abortError = signal.reason || new Error("Operation aborted.");
  if (signal.aborted) return Promise.reject(abortError);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason || abortError);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function isNewerVersion(latestVersion, currentVersion) {
  const latestParts = parseSemverParts(latestVersion);
  const currentParts = parseSemverParts(currentVersion);
  if (!latestParts || !currentParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }
  return false;
}

export function parseSemverParts(value) {
  const match = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function defaultWorkspaceDir(build) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  return `twinkle-${titleSlug || "build"}-${buildId}`;
}

export function defaultReferenceDir(build) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  return `twinkle-reference-${titleSlug || "build"}-${buildId}`;
}

export function defaultMainCheckoutDir(build) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  return `twinkle-main-${titleSlug || "build"}-${buildId}`;
}

export function defaultVersionCheckoutDir(build, versionNumber) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  const version = Number(versionNumber || 0) || "version";
  return `twinkle-v${version}-${titleSlug || "build"}-${buildId}`;
}

export function resolveRequiredBuildId(value) {
  const buildId = resolveBuildReference(value).buildId;
  if (buildId > 0) return buildId;
  throw new Error(
    "Pass a Twinkle build URL, app URL, preview URL, or build id.",
  );
}

export function resolveBuildId(value) {
  return resolveBuildReference(value).buildId;
}

export function resolveBuildReference(value) {
  const rawValue = String(value || "").trim();
  const directId = Number(rawValue);
  if (Number.isFinite(directId) && directId > 0) {
    return { buildId: directId, branchNumber: 0 };
  }
  if (!rawValue) return { buildId: 0, branchNumber: 0 };

  try {
    const parsedUrl = new URL(rawValue);
    const host = parsedUrl.hostname.toLowerCase();
    const previewHost = host.match(/^b-(\d+)\.preview\.lumine\.app$/);
    if (previewHost) {
      return { buildId: Number(previewHost[1]) || 0, branchNumber: 0 };
    }

    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const appIndex = parts.indexOf("app");
    if (appIndex >= 0) {
      return { buildId: Number(parts[appIndex + 1]) || 0, branchNumber: 0 };
    }

    const buildIndex = parts.indexOf("build");
    if (buildIndex >= 0) {
      if (parts[buildIndex + 1] === "preview") {
        const nestedBuildIndex = parts.indexOf("build", buildIndex + 2);
        return {
          buildId: Number(parts[nestedBuildIndex + 1]) || 0,
          branchNumber: 0,
        };
      }
      return {
        buildId: Number(parts[buildIndex + 1]) || 0,
        branchNumber: Number(parts[buildIndex + 2]) || 0,
      };
    }

    return {
      buildId:
        Number(parsedUrl.searchParams.get("buildId")) ||
        Number(parsedUrl.searchParams.get("build")) ||
        0,
      branchNumber: 0,
    };
  } catch {
    const match = rawValue.match(
      /(?:^|\/)(?:app|build)\/(?:preview\/build\/)?(\d+)(?:\/(\d+))?(?:\/|$)/,
    );
    return {
      buildId: Number(match?.[1] || 0) || 0,
      branchNumber: Number(match?.[2] || 0) || 0,
    };
  }
}
