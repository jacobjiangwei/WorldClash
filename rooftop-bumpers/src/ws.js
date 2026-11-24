// 极简 WebSocket 服务端（RFC 6455），零依赖。
// 只实现游戏需要的部分：文本/二进制帧、分片、ping/pong、close，不支持压缩扩展。

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 处理 HTTP upgrade 请求。握手不合法时回 400 并返回 null。
 * @returns {WsConnection|null}
 */
export function acceptWebSocket(req, socket, head, { maxPayload = 4096 } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const valid =
    req.method === 'GET' &&
    upgrade === 'websocket' &&
    req.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    /^[A-Za-z0-9+/]{22}==$/.test(key);
  if (!valid) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const ws = new WsConnection(socket, maxPayload);
  if (head && head.length) ws._onData(head);
  return ws;
}

export class WsConnection extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.closed = false;
    this.lastSeen = Date.now();
    this._buf = Buffer.alloc(0);
    this._frags = null;
    this._fragLen = 0;
    this._fragOp = 0;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', () => this._finish());
  }

  /** 已排队但尚未发出的字节数（用于跳过网速慢的客户端）。 */
  get bufferedAmount() {
    return this.socket.writableLength;
  }

  send(data) {
    if (this.closed) return;
    if (typeof data === 'string') this._sendFrame(0x1, Buffer.from(data, 'utf8'));
    else if (Buffer.isBuffer(data)) this._sendFrame(0x2, data);
    else if (data instanceof ArrayBuffer) this._sendFrame(0x2, Buffer.from(data));
    else this._sendFrame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  ping() {
    if (!this.closed) this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this._finish();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  terminate() {
    this._finish();
    this.socket.destroy();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this._buf = Buffer.alloc(0);
    this._frags = null;
    this.emit('close');
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload], header.length + len));
    } catch {
      this._finish();
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv !== 0 || !masked) return this.close(1002, 'protocol error'); // 客户端帧必须带掩码
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.close(1009, 'too big');
        len = b.readUInt32BE(6);
        off = 10;
      }
      if (len > this.maxPayload) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return; // 等待更多数据
      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this._buf = b.subarray(off + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      // 控制帧
      if (!fin || payload.length > 125) return this.close(1002, 'protocol error');
      if (opcode === 0x8) {
        if (!this.closed) {
          this._sendFrame(0x8, payload.subarray(0, 2));
          this._finish();
          this.socket.end();
        }
        return;
      }
      if (opcode === 0x9) return this._sendFrame(0xa, payload);
      if (opcode === 0xa) return; // pong
      return this.close(1002, 'protocol error');
    }
    if (opcode === 0x0) {
      // 续帧
      if (!this._frags) return this.close(1002, 'protocol error');
      this._fragLen += payload.length;
      if (this._fragLen > this.maxPayload) return this.close(1009, 'too big');
      this._frags.push(payload);
      if (fin) {
        const data = Buffer.concat(this._frags);
        const op = this._fragOp;
        this._frags = null;
        this._emitMessage(op, data);
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this._frags) return this.close(1002, 'protocol error');
      if (!fin) {
        this._frags = [payload];
        this._fragLen = payload.length;
        this._fragOp = opcode;
        return;
      }
      return this._emitMessage(opcode, payload);
    }
    return this.close(1002, 'protocol error');
  }

  _emitMessage(opcode, data) {
    if (opcode === 0x1) this.emit('message', data.toString('utf8'), false);
    else this.emit('message', data, true);
  }
}
