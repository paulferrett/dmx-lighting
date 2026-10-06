// ENTTEC DMX USB PRO over its FTDI serial port. One framed packet carries a
// whole universe: 0x7E, label 6, length LSB/MSB, start code 0, 512 bytes,
// 0xE7. The Pro keeps retransmitting the last frame by itself, so a frame
// only needs sending when something changes.
//
//   node enttec.js --probe     ask the widget for its serial and firmware;
//                              sends no DMX, so it is safe with the rig live

import { closeSync, constants, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function findDevice() {
  const names = readdirSync('/dev').filter((n) => n.startsWith('cu.usbserial'));
  const enttec = names.find((n) => n.startsWith('cu.usbserial-EN')) ?? names[0];
  return enttec ? `/dev/${enttec}` : null;
}

function packet(label, data) {
  const buf = Buffer.alloc(data.length + 5);
  buf[0] = 0x7e;
  buf[1] = label;
  buf[2] = data.length & 0xff;
  buf[3] = data.length >> 8;
  buf.set(data, 4);
  buf[buf.length - 1] = 0xe7;
  return buf;
}

export class Enttec {
  constructor(path = findDevice()) {
    this.path = path;
    this.fd = null;
  }

  open() {
    if (!this.path) throw new Error('no ENTTEC found — nothing at /dev/cu.usbserial-*');
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
    // Raw mode while our descriptor is open, or the tty layer rewrites 0x0A
    // bytes in the universe as CR LF.
    execFileSync('stty', ['-f', this.path, 'raw', '-echo', '-echoe', '-echok', '115200']);
  }

  sendDmx(universe) {
    const data = Buffer.alloc(513);
    data[0] = 0; // start code
    data.set(universe.subarray(0, 512), 1);
    this.write(packet(6, data));
  }

  write(buf) {
    try { writeSync(this.fd, buf); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }

  // Send a request and collect the reply packet with the same label.
  request(label, data = Buffer.alloc(0), timeoutMs = 1000) {
    this.write(packet(label, data));
    const deadline = Date.now() + timeoutMs;
    const chunks = [];
    const chunk = Buffer.alloc(600);
    while (Date.now() < deadline) {
      let n = 0;
      try { n = readSync(this.fd, chunk, 0, chunk.length, null); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
      if (n > 0) chunks.push(Buffer.from(chunk.subarray(0, n)));
      const all = Buffer.concat(chunks);
      const start = all.indexOf(0x7e);
      if (start >= 0 && all.length >= start + 4) {
        const len = all[start + 2] | (all[start + 3] << 8);
        if (all.length >= start + 5 + len && all[start + 1] === label) return all.subarray(start + 4, start + 4 + len);
      }
      if (n === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return null;
  }

  close() {
    if (this.fd != null) { try { closeSync(this.fd); } catch { /* already gone */ } }
    this.fd = null;
  }
}

if (process.argv.includes('--probe')) {
  const dev = new Enttec();
  console.log('device', dev.path ?? '(none)');
  dev.open();
  const serial = dev.request(10);
  console.log('serial', serial ? [...serial].reverse().map((b) => b.toString(16).padStart(2, '0')).join('') : 'no reply');
  const params = dev.request(3, Buffer.from([0, 0]));
  if (params) {
    console.log(`firmware ${params[1]}.${params[0]}  break ${params[2] * 10.67}µs  MAB ${params[3] * 10.67}µs  refresh ${params[4]} fps`);
  } else console.log('params no reply');
  dev.close();
}
