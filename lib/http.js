import { parseJson } from "./util.js";

export async function requestJson({
  method = "GET",
  url,
  authToken,
  body,
  timeoutMs,
  headers = {},
}) {
  const response = await request({
    method,
    url,
    authToken,
    body,
    timeoutMs,
    headers,
  });
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const error = new Error(
      data?.error || data?.message || `${method} ${url} failed`,
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data || {};
}

export async function probeUrl({ url, authToken, timeoutMs }) {
  const response = await request({ url, authToken, timeoutMs });
  const text = await response.text();
  return {
    ok: response.ok && text.trim().length > 0,
    status: response.status,
    bytes: Buffer.byteLength(text),
  };
}

export async function request({
  method = "GET",
  url,
  authToken,
  body,
  timeoutMs,
  headers = {},
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        ...(authToken ? { authorization: authorizationHeader(authToken) } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function authorizationHeader(authToken) {
  const token = String(authToken || "").trim();
  if (!token) return "";
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}
