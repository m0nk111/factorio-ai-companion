import { Socket } from "node:net";
import type { RCONConfig, RCONResponse } from "./types";
import { validateRCONConfig } from "../config";

const MAX_PACKET = 4 * 1024 * 1024;

export function encodePacket(id: number, type: number, payload: string): Buffer {
  const bytes = Buffer.from(payload, "utf8");
  const packet = Buffer.alloc(bytes.length + 14);
  packet.writeInt32LE(bytes.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bytes.copy(packet, 12);
  return packet;
}

type Pending = {
  id: number;
  barrier?: number;
  chunks: Buffer[];
  bytes: number;
  /** The barrier answered before the command produced any output. */
  barrierSeen: boolean;
  settle?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
};

/** One framed TCP reader and one serialized command queue, including response barriers. */
export class RCONClient {
  private socket: Socket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly config: RCONConfig,
    private readonly timeoutMs = 5000,
    /**
     * Quiet window used only when the barrier answers before the command produced any
     * output. Factorio answers built-in commands like `/version` immediately while a
     * queued `/fac_api` may complete on a later tick, so the command's own reply can
     * arrive after the barrier. Chunks reset the window; it never decides that a
     * command without output succeeded.
     */
    private readonly lateBodySettleMs = 200,
    /**
     * Upper bound for waiting on the first chunk when the barrier already answered. A
     * command that stays silent beyond it is reported as an unknown outcome instead of
     * hanging until the request timeout.
     */
    private readonly missingReplyMs = 2000,
  ) {
    validateRCONConfig(config);
    for (const [name, value] of [
      ["lateBodySettleMs", lateBodySettleMs],
      ["missingReplyMs", missingReplyMs],
    ] as const)
      if (!Number.isFinite(value) || value < 0)
        throw new Error(`${name} must be a finite non-negative number`);
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("RCON client stopped");
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async open(): Promise<void> {
    const socket = new Socket();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on("data", (data: Buffer) => {
      if (this.socket === socket) this.receive(data);
    });
    socket.on("error", (error) => {
      if (this.socket === socket) this.fail(error);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.fail(new Error("Factorio RCON disconnected"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("RCON connection timed out"));
          socket.destroy();
        }, this.timeoutMs);
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          reject(new Error("RCON connection closed"));
        });
        socket.connect(this.config.port, this.config.host, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await this.exchange(3, this.config.password, this.timeoutMs);
      this.connected = true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async sendCommand(command: string, timeoutMs = this.timeoutMs): Promise<RCONResponse> {
    if (!command.trim() || /[\r\n\0]/.test(command) || Buffer.byteLength(command) > 128 * 1024) {
      return { success: false, data: "", error: "Invalid RCON command" };
    }
    const operation = this.serial.then(async (): Promise<RCONResponse> => {
      try {
        await this.connect();
        return { success: true, data: await this.exchange(2, command, timeoutMs) };
      } catch (error) {
        return {
          success: false,
          data: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    this.serial = operation;
    return operation;
  }

  private exchange(type: number, payload: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // Factorio processes commands in order; a harmless built-in command delimits replies.
      // Factorio ignores empty commands and rejects Source RESPONSE_VALUE probes.
      const barrier = type === 2 ? this.nextId++ : undefined;
      const timer = setTimeout(() => {
        // A barrier that answered while the command produced nothing is a distinct
        // outcome: the mod did run, its reply never reached this interface.
        const missingReply = this.pending?.barrierSeen && this.pending.bytes === 0;
        this.fail(
          new Error(
            missingReply
              ? `RCON timeout after ${timeoutMs} ms; the command produced no reply after the barrier answered; outcome unknown, command not retried`
              : `RCON timeout after ${timeoutMs} ms; outcome unknown, command not retried`,
          ),
        );
      }, timeoutMs);
      this.pending = {
        id,
        barrier,
        chunks: [],
        bytes: 0,
        barrierSeen: false,
        timer,
        resolve,
        reject,
      };
      if (!this.socket || this.socket.destroyed) {
        this.fail(new Error("RCON socket closed"));
        return;
      }
      this.socket.write(encodePacket(id, type, payload));
      if (barrier !== undefined) this.socket.write(encodePacket(barrier, 2, "/version"));
    });
  }

  private receive(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > MAX_PACKET) {
        this.fail(new Error("Invalid RCON packet length"));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const packet = this.buffer.subarray(0, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      if (packet[packet.length - 1] !== 0 || packet[packet.length - 2] !== 0) {
        this.fail(new Error("Invalid RCON packet terminator"));
        return;
      }
      const id = packet.readInt32LE(4);
      const type = packet.readInt32LE(8);
      const pending = this.pending;
      if (!pending) continue;
      if (type === 2 && id === -1) {
        this.fail(new Error("RCON authentication failed: invalid password"));
        return;
      }
      if (pending.barrier === undefined) {
        if (id === pending.id && type === 2) this.finish("");
      } else if (id === pending.barrier) {
        pending.barrierSeen = true;
        // Normal path: the command already answered, so nothing more can follow it.
        if (pending.bytes > 0) this.finish(this.collected(pending));
        // Otherwise the command may still complete on a later tick: wait for its own reply
        // instead of turning a missing answer into an empty successful response.
        else this.settle(pending);
      } else if (id === pending.id && type === 0) {
        const body = packet.subarray(12, packet.length - 2);
        pending.bytes += body.length;
        if (pending.bytes > MAX_PACKET) {
          this.fail(new Error("RCON response too large"));
          return;
        }
        pending.chunks.push(body);
        if (pending.barrierSeen) this.settle(pending);
      }
    }
  }

  private collected(pending: Pending): string {
    return Buffer.concat(pending.chunks).toString("utf8");
  }

  /**
   * Resolve a request whose barrier answered before the command's own reply: either the
   * reply is still arriving (close it once quiet for {@link lateBodySettleMs}) or it never
   * arrives (fail as unknown after {@link missingReplyMs}). Every new chunk restarts the
   * window, so a slow multi-packet reply is never truncated.
   */
  private settle(pending: Pending): void {
    if (pending.settle) clearTimeout(pending.settle);
    const awaitingFirstChunk = pending.bytes === 0;
    pending.settle = setTimeout(
      () => {
        if (this.pending !== pending) return;
        if (pending.bytes > 0) this.finish(this.collected(pending));
        else
          this.fail(
            new Error(
              `RCON: the command produced no reply within ${this.missingReplyMs} ms after the barrier answered; outcome unknown, command not retried`,
            ),
          );
      },
      awaitingFirstChunk ? this.missingReplyMs : this.lateBodySettleMs,
    );
  }

  private finish(data: string): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      if (pending.settle) clearTimeout(pending.settle);
      clearTimeout(pending.timer);
      pending.resolve(data);
    }
  }

  private fail(error: Error): void {
    this.connected = false;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      if (pending.settle) clearTimeout(pending.settle);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.buffer = Buffer.alloc(0);
  }

  isConnected(): boolean {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.closed = true;
    this.fail(new Error("RCON client stopped"));
  }
}
