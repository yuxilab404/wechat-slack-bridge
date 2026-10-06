import { Agent, fetch } from "undici";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { parse, isLosslessNumber } from "lossless-json";
export class Fault extends Error {
  constructor(
    public code: string,
    public retryMs = 0,
    public uncertain = false,
    public stage = "",
    public apiCode = "",
  ) {
    super(code);
  }
}
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function checkUrl(raw: string, hosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Fault("地址无效");
  }
  if (
    url.protocol !== "https:" ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.includes(url.hostname)
  )
    throw new Fault("地址不在安全白名单");
  return url;
}
export type Reply = { status: number; headers: Headers; bytes: Buffer };
export type Transport = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  limit: number,
) => Promise<Reply>;
const dispatcher = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (
          error ||
          !addresses.length ||
          addresses.some((a) => !publicAddress(a.address))
        ) {
          callback(new Error("拒绝非公网地址"), "", 4);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    },
  },
});
export const network: Transport = async (url, method, headers, body, limit) => {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      dispatcher,
      signal: AbortSignal.timeout(45000),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new Fault("拒绝重定向");
    }
    if (Number(res.headers.get("content-length")) > limit) {
      await res.body?.cancel();
      throw new Fault("媒体或响应超过限额");
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of res.body ?? []) {
      size += part.length;
      if (size > limit) throw new Fault("媒体或响应超过限额");
      parts.push(Buffer.from(part));
    }
    return {
      status: res.status,
      headers: new Headers([...res.headers]),
      bytes: Buffer.concat(parts),
    };
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault("网络请求失败", 0, true);
  }
};
export class Http {
  constructor(private transport: Transport = network) {}
  async bytes(
    url: string,
    hosts: string[],
    method = "GET",
    headers: Record<string, string> = {},
    body?: Buffer,
    limit = 2 * 1024 * 1024,
  ): Promise<Reply> {
    checkUrl(url, hosts);
    let r: Reply;
    try {
      r = await this.transport(url, method, headers, body, limit);
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault("网络请求失败", 0, true);
    }
    if (r.bytes.length > limit) throw new Fault("媒体或响应超过限额");
    if (r.status === 429) {
      const seconds = Number(r.headers.get("retry-after"));
      throw new Fault(
        "接口限流",
        Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 60000),
      );
    }
    if (r.status < 200 || r.status >= 300)
      throw new Fault("接口请求失败", 0, r.status >= 500);
    return r;
  }
  async json(
    url: string,
    hosts: string[],
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<any> {
    const r = await this.bytes(
      url,
      hosts,
      body === undefined ? "GET" : "POST",
      body === undefined
        ? headers
        : {
            "Content-Type":
              body instanceof URLSearchParams
                ? "application/x-www-form-urlencoded; charset=utf-8"
                : "application/json",
            ...headers,
          },
      body === undefined
        ? undefined
        : Buffer.from(
            body instanceof URLSearchParams
              ? body.toString()
              : JSON.stringify(body),
          ),
    );
    try {
      return parse(r.bytes.toString("utf8"), (_key, value) =>
        isLosslessNumber(value)
          ? Number.isSafeInteger(Number(value.value))
            ? Number(value.value)
            : value.value
          : value,
      );
    } catch {
      throw new Fault("接口响应格式无效", 0, true);
    }
  }
}
