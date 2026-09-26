/**
 * Test plumbing for the connector runtime: a local plain-HTTP server and a transport that sends what
 * `executeHttpAction` built for `https://<host>:443` to that server instead, recording the options it was given
 * (pinned lookup, servername, autoSelectFamily, headers). No network beyond 127.0.0.1; $0.
 */
import http from "node:http";
import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { HttpRequestFn } from "@/server/connectors/http";
import type { ConnectorResolver } from "@/server/connectors/dns";

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface LocalServer {
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

export async function startServer(
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<LocalServer> {
  const seen: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      void handle(req, res, body);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface CapturedCall {
  options: RequestOptions & { autoSelectFamily?: boolean; servername?: string };
  /** What the runtime's pinned `lookup` answered (plain and `{all:true}`). */
  pinned: { plain: [string, number]; all: { address: string; family: number }[] };
}

/** A transport that records the https options and sends the request over plain HTTP to `port` on 127.0.0.1. */
export function localTransport(port: number, calls: CapturedCall[]): HttpRequestFn {
  return ((options: CapturedCall["options"], cb: (res: IncomingMessage) => void) => {
    const lookup = options.lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
    const call: CapturedCall = { options, pinned: { plain: ["", 0], all: [] } };
    calls.push(call);
    lookup(String(options.hostname), {}, (_e, a, f) => {
      call.pinned.plain = [a as string, f as number];
    });
    lookup(String(options.hostname), { all: true }, (_e, list) => {
      call.pinned.all = list as { address: string; family: number }[];
    });
    const { lookup: _l, servername: _s, agent: _a, protocol: _p, autoSelectFamily: _f, family: _fam, ...rest } = options;
    return http.request({ ...rest, protocol: "http:", hostname: "127.0.0.1", port, agent: false }, cb);
  }) as unknown as HttpRequestFn;
}

/** A resolver that answers from a table (and counts calls); unknown names → ENOTFOUND. */
export function tableResolver(table: Record<string, { v4?: string[]; v6?: string[] }>): ConnectorResolver & { calls: string[] } {
  const calls: string[] = [];
  const miss = (host: string) => Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return {
    calls,
    async resolve4(host) {
      calls.push(`A ${host}`);
      const e = table[host];
      if (!e?.v4) throw miss(host);
      return e.v4;
    },
    async resolve6(host) {
      calls.push(`AAAA ${host}`);
      const e = table[host];
      if (!e?.v6) throw Object.assign(new Error(`queryAaaa ENODATA ${host}`), { code: "ENODATA" });
      return e.v6;
    },
  };
}

/** A public, unicast documentation-free address that the transport never really dials. */
export const PUBLIC_V4 = "93.184.215.14";
export const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
