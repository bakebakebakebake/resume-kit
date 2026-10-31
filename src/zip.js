/**
 * 最小 ZIP 写入器（deflate 压缩）。
 *
 * .docx 就是个规定了内部结构的 zip。为了写一个 zip 去装 archiver / jszip
 * 不划算 —— 这里只需要"把几个内存里的字符串打成一个包"，
 * 不需要读、不需要流式、不需要加密，一百来行就够。
 *
 * 格式参考 PKWARE APPNOTE 6.3.x，只用到最基本的那几个结构：
 *   [本地文件头 + 数据] × N  →  [中央目录项] × N  →  [中央目录结尾]
 */

import { deflateRawSync } from 'node:zlib';

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

/**
 * 外部属性的高 16 位是 Unix 权限位（因为"打包工具版本"高字节声明了 Unix）。
 * 这里必须写实际权限：留 0 的话解出来是 `----------`，
 * Word 不在乎，但谁想解开 docx 看一眼都会撞上"权限不足"。
 *
 * `>>> 0` 不能省：左移 16 位后最高位是 1，JS 的位运算按有符号 32 位算，
 * 直接拿去 writeUInt32LE 会因为是负数被拒。
 */
const UNIX_MODE_644 = (0o100644 << 16) >>> 0;

/** ZIP 用的是 MS-DOS 时间格式：日期和时间各挤在一个 16 位里 */
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {Array<{name: string, data: string|Buffer}>} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const packed = deflateRawSync(raw, { level: 9 });
    // 压完反而更大就存原始的（小文件会这样）
    const useDeflate = packed.length < raw.length;
    const data = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 无扩展字段
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录项签名
    central.writeUInt16LE(0x031e, 4); // 打包工具版本（Unix）
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段长
    central.writeUInt16LE(0, 32); // 注释长
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(UNIX_MODE_644, 38); // 外部属性：Unix 0644
    central.writeUInt32LE(offset, 42); // 本地头偏移
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结尾签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 无注释

  return Buffer.concat([...locals, ...centrals, end]);
}
