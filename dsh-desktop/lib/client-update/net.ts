import * as https from 'node:https';
import * as http from 'node:http';
import type { HttpResponse } from './types.js';

export function headerValue(headers: NodeJS.Dict<string | string[]>, name: string): string | string[] | undefined {
  const value = headers && headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function getResponse(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; redirects?: number } = {},
): Promise<HttpResponse> {
  const { headers = {}, timeoutMs = 20_000, redirects = 0 } = opts;
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise<HttpResponse>((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        getResponse(new URL(loc, url).toString(), { headers, timeoutMs, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

export async function httpGetJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<unknown> {
  const { status, stream } = await getResponse(url, { headers, timeoutMs });
  if (status !== 200) {
    stream.resume();
    throw new Error('HTTP ' + status);
  }
  let body = '';
  await new Promise<void>((resolve, reject) => {
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) stream.destroy?.(new Error('响应过大'));
    });
    stream.on('end', () => resolve());
    stream.on('aborted', () => reject(new Error('连接中断')));
    stream.on('error', reject);
  });
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('JSON 解析失败');
  }
}

export function isNoSpaceError(err: unknown): boolean {
  if (!err) return false;
  const value = err as { code?: string; message?: string };
  if (value.code === 'ENOSPC') return true;
  return /no space left on device/i.test(String(value.message || ''));
}

export function noSpaceError(msg: string): Error & { code: string } {
  const err = new Error(msg) as Error & { code: string };
  err.code = 'ENOSPC';
  return err;
}
