// Cliente RCON nativo (Source RCON Protocol).
// Sem dependências externas — usa só `net` do Node.
import net from "node:net";

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXEC = 2;
const TYPE_RESPONSE_VALUE = 0;

function buildPacket(id, type, body) {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = bodyBuf.length + 10; // 4 (id) + 4 (type) + body + 2 nulls
  const buf = Buffer.alloc(size + 4);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt8(0, 12 + bodyBuf.length);
  buf.writeInt8(0, 13 + bodyBuf.length);
  return buf;
}

function parsePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32LE(offset);
    if (offset + 4 + size > buffer.length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer
      .slice(offset + 12, offset + 4 + size - 2)
      .toString("utf8");
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.slice(offset) };
}

// Envia um único comando, autentica, retorna a resposta e fecha a conexão.
export function rconExec({ host, port, password, command, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let authed = false;
    let response = "";
    const AUTH_ID = 1;
    const EXEC_ID = 2;

    const finish = (err, value) => {
      try {
        socket.destroy();
      } catch {}
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`RCON timeout após ${timeoutMs}ms`)),
      timeoutMs
    );

    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!authed) finish(new Error("Conexão RCON fechada antes de autenticar"));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { packets, rest } = parsePackets(buffer);
      buffer = rest;
      for (const pkt of packets) {
        if (pkt.type === TYPE_AUTH_RESPONSE && pkt.id === AUTH_ID) {
          authed = true;
          socket.write(buildPacket(EXEC_ID, TYPE_EXEC, command));
        } else if (pkt.type === TYPE_AUTH_RESPONSE && pkt.id === -1) {
          finish(new Error("Senha RCON inválida"));
        } else if (pkt.type === TYPE_RESPONSE_VALUE && pkt.id === EXEC_ID) {
          response += pkt.body;
          // Resposta pode vir fragmentada; damos um pequeno delay e finalizamos
          finish(null, response);
        }
      }
    });

    socket.connect(port, host, () => {
      socket.write(buildPacket(AUTH_ID, TYPE_AUTH, password));
    });
  });
}
