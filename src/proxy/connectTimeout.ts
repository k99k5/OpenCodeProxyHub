import type { ClientRequest } from "node:http";
import type { Socket } from "node:net";

export const PROXY_CONNECT_TIMEOUT_CODE = "EPROXYCONNECTTIMEOUT";

export class ProxyConnectTimeoutError extends Error {
  readonly code = PROXY_CONNECT_TIMEOUT_CODE;

  constructor(readonly timeoutMs: number) {
    super(`Proxy connect timeout after ${timeoutMs}ms`);
    this.name = "ProxyConnectTimeoutError";
  }
}

export interface ProxyConnectionControl {
  timeoutMs: number;
  abort(reason: Error): void;
}

export interface ArmedProxyConnectTimeout {
  didTimeout(): boolean;
  getError(): ProxyConnectTimeoutError | undefined;
}

type SecureSocket = Socket & {
  encrypted?: boolean;
  secureConnecting?: boolean;
};

const extractProxyConnectTimeoutError = (
  value: unknown,
): ProxyConnectTimeoutError | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const error = value as Error & { code?: string; cause?: unknown };
  if (error.code === PROXY_CONNECT_TIMEOUT_CODE) {
    return error as ProxyConnectTimeoutError;
  }
  if (error.cause === value) return undefined;
  return extractProxyConnectTimeoutError(error.cause);
};

export const armProxyConnectTimeout = (
  request: ClientRequest,
  control: ProxyConnectionControl | undefined,
): ArmedProxyConnectTimeout => {
  let timeoutError: ProxyConnectTimeoutError | undefined;
  if (!control) {
    return {
      didTimeout: () => false,
      getError: () => undefined,
    };
  }

  let socket: SecureSocket | undefined;
  let timer: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    request.off("socket", onSocket);
    request.off("response", clear);
    request.off("error", clear);
    request.off("close", clear);
    socket?.off("secureConnect", clear);
  };

  const onSocket = (connectedSocket: Socket): void => {
    socket = connectedSocket as SecureSocket;
    if (!socket.encrypted || socket.secureConnecting === false) {
      clear();
      return;
    }

    socket.once("secureConnect", clear);
    // Avoid missing a handshake that completed between assignment and listener setup.
    if (Reflect.get(socket, "secureConnecting") === false) clear();
  };

  request.once("socket", onSocket);
  request.once("response", clear);
  request.once("error", clear);
  request.once("close", clear);

  timer = setTimeout(() => {
    timeoutError = new ProxyConnectTimeoutError(control.timeoutMs);
    // Before the Agent assigns a socket, abort its private proxy connection.
    // Once assigned, ClientRequest owns the TLS socket and destroys it safely.
    if (!socket) control.abort(timeoutError);
    request.destroy(timeoutError);
  }, control.timeoutMs);
  timer.unref();

  return {
    didTimeout: () => Boolean(timeoutError),
    getError: () => timeoutError,
  };
};

export const resolveProxyConnectTimeoutError = (
  error: unknown,
  armed: ArmedProxyConnectTimeout,
): ProxyConnectTimeoutError | undefined => {
  const timeoutError = armed.getError();
  if (timeoutError) return timeoutError;
  return extractProxyConnectTimeoutError(error);
};
