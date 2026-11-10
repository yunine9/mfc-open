// PostgreSQL wire peer for exercising the real pg client without a database binary.
import { createServer, type Socket, type AddressInfo } from "node:net";

const packet = (kind: string, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5); header[0] = kind.charCodeAt(0);
  header.writeInt32BE(payload.length + 4, 1); return Buffer.concat([header, payload]);
};
const ready = () => packet("Z", Buffer.from("I"));
const complete = (command: string) => packet("C", Buffer.from(command + "\0"));

export async function projectionPeer(options: { silent?: boolean; writeDelayMs?: number } = {}) {
  const sockets = new Set<Socket>(); const timers = new Set<NodeJS.Timeout>();
  let writes = 0; let schemas = 0; let selects = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffered = Buffer.alloc(0); let startup = true;
    socket.on("data", data => {
      if (options.silent) return;
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const size = buffered.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffered.length < size) return;
        const body = buffered.subarray(0, size); buffered = buffered.subarray(size);
        if (startup) { startup = false; socket.write(Buffer.concat([packet("R", Buffer.alloc(4)), ready()])); continue; }
        const kind = String.fromCharCode(body[0]);
        if (kind === "Q") {
          if (body.toString().includes("create table")) schemas++; else selects++;
          socket.write(Buffer.concat([complete("SELECT 1"), ready()]));
        }
        if (kind === "P") socket.write(packet("1"));
        if (kind === "B") socket.write(packet("2"));
        if (kind === "D") socket.write(packet("n"));
        if (kind === "S") {
          const timer = setTimeout(() => {
            timers.delete(timer); writes++;
            if (!socket.destroyed) socket.write(Buffer.concat([complete("INSERT 0 1"), ready()]));
          }, options.writeDelayMs ?? 0);
          timers.add(timer);
        }
        if (kind === "X") socket.end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `postgresql://fixture@127.0.0.1:${(server.address() as AddressInfo).port}/fixture`,
    counts: () => ({ writes, schemas, selects, connections: sockets.size }),
    close: async () => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
