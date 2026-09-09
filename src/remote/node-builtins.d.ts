declare module "node:net" {
  export interface SocketError extends Error {
    readonly code?: string;
  }

  export interface Socket {
    setEncoding(encoding: "utf8"): this;
    on(event: "connect", listener: () => void): this;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): this;
    on(event: "error", listener: (error: SocketError) => void): this;
    on(event: "close", listener: () => void): this;
    write(data: string, callback?: () => void): boolean;
    end(data?: string, callback?: () => void): this;
    destroy(): this;
  }

  export interface Server {
    listen(path: string, callback?: () => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: "connection", listener: (socket: Socket) => void): this;
    on(event: "error", listener: (error: SocketError) => void): this;
    close(callback?: (error?: SocketError) => void): this;
  }

  export function createServer(listener?: (socket: Socket) => void): Server;
  export function createConnection(path: string, listener?: () => void): Socket;
}

declare module "node:fs" {
  interface FileStats {
    readonly isSocket?: () => boolean;
  }

  export function unlinkSync(path: string): void;
  export function lstatSync(path: string): FileStats;
}
