import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { SocksClient } from "socks";
import { SocksProxyAgent } from "socks-proxy-agent";

const setServernameFromNonIpHost = (
  options: Parameters<SocksProxyAgent["connect"]>[1],
): Record<string, unknown> => {
  const values = options as unknown as Record<string, unknown>;
  if (values.servername === undefined
    && typeof options.host === "string"
    && !net.isIP(options.host)) {
    return { ...values, servername: options.host };
  }
  return values;
};

const omit = <T extends Record<string, unknown>>(
  value: T,
  ...keys: string[]
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key)) result[key] = item;
  }
  return result;
};

export class ConnectTimeoutSocksProxyAgent extends SocksProxyAgent {
  constructor(
    proxyUrl: string,
    private readonly connectTimeoutMs: number,
    signal: AbortSignal,
  ) {
    super(proxyUrl, {
      socketOptions: { signal },
    });
  }

  override async connect(
    request: Parameters<SocksProxyAgent["connect"]>[0],
    options: Parameters<SocksProxyAgent["connect"]>[1],
  ): Promise<Awaited<ReturnType<SocksProxyAgent["connect"]>>> {
    if (!options.host) throw new Error("No `host` defined!");

    const deadline = Date.now() + this.connectTimeoutMs;
    let host = options.host;
    if (this.shouldLookup) {
      const lookup = (options.lookup || dns.lookup) as typeof dns.lookup;
      host = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const timer = setTimeout(() => {
          finish(() => reject(new Error("Proxy connection timed out during DNS lookup")));
        }, Math.max(1, deadline - Date.now()));
        timer.unref();

        lookup(host, { all: false }, (error, address) => {
          if (error) {
            finish(() => reject(error));
            return;
          }
          const resolved = Array.isArray(address)
            ? address[0]?.address
            : address;
          if (!resolved) {
            finish(() => reject(new Error(`Unable to resolve proxy target host: ${host}`)));
            return;
          }
          finish(() => resolve(resolved));
        });
      });
    }

    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new Error("Proxy connection timed out");
    }
    const { socket } = await SocksClient.createConnection({
      proxy: this.proxy,
      destination: {
        host,
        port: typeof options.port === "number"
          ? options.port
          : Number.parseInt(options.port, 10),
      },
      command: "connect",
      timeout: remainingTimeoutMs,
      // socks always replaces host and port with the configured proxy endpoint.
      // @ts-expect-error socks declares a wider socket option type than it consumes here.
      socket_options: this.socketOptions || undefined,
    });

    if (!options.secureEndpoint) return socket;

    const tlsSocket = tls.connect({
      ...omit(
        setServernameFromNonIpHost(options),
        "host",
        "path",
        "port",
      ),
      socket,
    });
    tlsSocket.once("error", () => {
      request.destroy();
      socket.destroy();
      tlsSocket.destroy();
    });
    return tlsSocket;
  }
}
