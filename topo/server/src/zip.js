// 最小 ZIP 写入器（store，不压缩）：拓扑/文档都是 KB 级文本，压缩收益远不值得引入依赖
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

export function makeZip(entries, when = new Date()) {
  const { time, day } = dosDateTime(when);
  const items = entries.map((entry) => {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    if (nameBuf.length > 0xffff) throw new Error("path too long");   // zip 头部是 16 位长度字段
    return { nameBuf, data, crc: crc32(data) };
  });

  // 一次性算准总长度，避免 Buffer.concat 造成的双份内存
  let total = 22;
  for (const it of items) total += 30 + it.nameBuf.length + it.data.length + 46 + it.nameBuf.length;
  const out = Buffer.alloc(total);
  let p = 0;
  const centrals = [];
  let offset = 0;

  for (const it of items) {
    const { nameBuf, data, crc } = it;
    out.writeUInt32LE(0x04034b50, p);
    out.writeUInt16LE(20, p + 4);
    out.writeUInt16LE(0x0800, p + 6);          // UTF-8 文件名
    out.writeUInt16LE(0, p + 8);               // store
    out.writeUInt16LE(time, p + 10);
    out.writeUInt16LE(day, p + 12);
    out.writeUInt32LE(crc, p + 14);
    out.writeUInt32LE(data.length, p + 18);
    out.writeUInt32LE(data.length, p + 22);
    out.writeUInt16LE(nameBuf.length, p + 26);
    out.writeUInt16LE(0, p + 28);
    nameBuf.copy(out, p + 30);
    data.copy(out, p + 30 + nameBuf.length);
    const localLen = 30 + nameBuf.length + data.length;
    centrals.push({ nameBuf, crc, data, localLen, offset });
    p += localLen;
    offset += localLen;
  }

  const centralStart = p;
  for (const c of centrals) {
    const { nameBuf, crc, data, localLen, offset: localOffset } = c;
    out.writeUInt32LE(0x02014b50, p);
    out.writeUInt16LE(20, p + 4);
    out.writeUInt16LE(20, p + 6);
    out.writeUInt16LE(0x0800, p + 8);
    out.writeUInt16LE(0, p + 10);
    out.writeUInt16LE(time, p + 12);
    out.writeUInt16LE(day, p + 14);
    out.writeUInt32LE(crc, p + 16);
    out.writeUInt32LE(data.length, p + 20);
    out.writeUInt32LE(data.length, p + 24);
    out.writeUInt16LE(nameBuf.length, p + 28);
    out.writeUInt32LE(0, p + 30);              // 外部属性
    out.writeUInt32LE(localOffset, p + 42);
    nameBuf.copy(out, p + 46);
    p += 46 + nameBuf.length;
  }

  out.writeUInt32LE(0x06054b50, p);
  out.writeUInt16LE(entries.length, p + 8);
  out.writeUInt16LE(entries.length, p + 10);
  out.writeUInt32LE(p - centralStart, p + 12);
  out.writeUInt32LE(centralStart, p + 16);

  return out;
}
