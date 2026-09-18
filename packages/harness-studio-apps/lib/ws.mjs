/**
 * Minimal WebSocket endpoint for ``/api/ws`` — the dashboard shell's realtime
 * channel.
 *
 * The compat host accepts connections and speaks just enough of RFC 6455 to
 * stay alive (handshake, ping→pong, close, masked client frames) plus a
 * ``broadcast()`` for future realtime frames. Nothing is pushed on connect yet:
 * the shell's authoritative slot list arrives over HTTP
 * (``GET /api/chat/slots``), exactly as it does on the real gateway when the
 * stream has nothing newer than the reply.
 */
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, data])
}

export function attachWebSocket(server, { path = '/api/ws', logger }) {
  const clients = new Set()

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n'),
    )
    socket.setNoDelay(true)
    clients.add(socket)
    logger.info(`ws client connected (${clients.size} open)`)

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // Parse client frames; there is no application protocol yet, so only
      // control frames are acted on and payloads are dropped.
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (masked) {
          if (buffer.length < offset + 4) return
          offset += 4
        }
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          // close
          socket.end(encodeFrame(Buffer.alloc(0), 0x8))
        } else if (opcode === 0x9) {
          // ping → pong
          socket.write(encodeFrame(payload, 0xa))
        }
      }
    })
    const drop = () => {
      clients.delete(socket)
      logger.info(`ws client disconnected (${clients.size} open)`)
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  function broadcast(payload) {
    const frame = encodeFrame(JSON.stringify(payload))
    for (const socket of clients) {
      try {
        socket.write(frame)
      } catch {
        clients.delete(socket)
      }
    }
  }

  return { broadcast, clientCount: () => clients.size }
}
