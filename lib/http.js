import { parseJson } from "./util.js";

export async function requestJson({
  method = "GET",
  url,
  authToken,
  body,
  timeoutMs,
  headers = {},
  signal,
}) {
  const { response, text } = await requestText({
    method,
    url,
    authToken,
    body,
    timeoutMs,
    headers,
    signal,
  });
  const data = parseJson(text);
  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
        (typeof data?.error === "string" ? data.error : "") ||
        data?.message ||
        `${method} ${url} failed`,
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data || {};
}

export async function probeUrl({ url, authToken, timeoutMs, signal }) {
  const { response, text } = await requestText({
    url,
    authToken,
    timeoutMs,
    signal,
  });
  return {
    ok: response.ok && text.trim().length > 0,
    status: response.status,
    bytes: Buffer.byteLength(text),
  };
}

export async function requestText({
  method = "GET",
  url,
  authToken,
  body,
  timeoutMs,
  headers = {},
  signal,
}) {
  const controller = new AbortController();
  const parentAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) parentAbort();
  else signal?.addEventListener("abort", parentAbort, { once: true });
  const effectiveTimeoutMs = Math.max(Number(timeoutMs) || 0, 1);
  const timeoutError = new Error(
    `HTTP request timed out after ${effectiveTimeoutMs}ms.`,
  );
  timeoutError.code = "lumine_http_timeout";
  const timeout = setTimeout(
    () => controller.abort(timeoutError),
    effectiveTimeoutMs,
  );
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(authToken ? { authorization: authorizationHeader(authToken) } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", parentAbort);
  }
}

export function authorizationHeader(authToken) {
  const token = String(authToken || "").trim();
  if (!token) return "";
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}
