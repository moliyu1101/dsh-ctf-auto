// dsh-ctf-auto / lib/pack.js —— WP 打包（最小 ustar tar + gzip，纯 Node 无依赖）。
//
import zlib from "node:zlib";

// 用于「Writeup 自动打包」：把 writeup.md / notes.md / scripts / artifacts / triage.json
// 打成一个 .tar.gz，便于交付与归档。宿主负责收集文件内容，本模块只负责编码。

const BLOCK = 512;

function octal(value, width) {
	const text = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
	return text.length >= width ? text.slice(-(width - 1)) + "\0" : text.padStart(width - 1, "0") + "\0";
}

function padTo(value, size, fill = 0) {
	const buf = Buffer.alloc(size, fill);
	const src = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
	src.copy(buf, 0, 0, Math.min(src.length, size));
	return buf;
}

function normalizeName(name) {
	return String(name ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\.\.(\/|$)/g, "")
		.slice(0, 100);
}

/** 生成一个 ustar header（512 字节）。 */
function tarHeader({ name, size, mode = 0o644, mtime = 0, type = "0" }) {
	const header = Buffer.alloc(BLOCK, 0);
	padTo(normalizeName(name), 100).copy(header, 0);
	padTo(octal(mode, 8), 8).copy(header, 100);
	padTo(octal(0, 8), 8).copy(header, 108);
	padTo(octal(0, 8), 8).copy(header, 116);
	padTo(octal(size, 12), 12).copy(header, 124);
	padTo(octal(Math.floor(Number(mtime) / 1000) || 0, 12), 12).copy(header, 136);
	header.write("        ", 148, 8, "latin1"); // 先留空格，再算 checksum
	header.write(type, 156, 1, "latin1");
	header.write("ustar\0", 257, 6, "latin1");
	header.write("00", 263, 2, "latin1");
	let sum = 0;
	for (let i = 0; i < BLOCK; i += 1) sum += header[i];
	const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
	header.write(checksum, 148, 8, "latin1");
	return header;
}

/**
 * 生成 tar.gz。
 * @param {Array<{name:string, data?:Buffer|string, mtime?:number, mode?:number}>} entries
 * @returns {Buffer}
 */
export function buildTarGz(entries) {
	const chunks = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || !entry.name) continue;
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
		chunks.push(tarHeader({ name: entry.name, size: data.length, mtime: entry.mtime || Date.now(), mode: entry.mode || 0o644 }));
		chunks.push(data);
		const remainder = data.length % BLOCK;
		if (remainder > 0) chunks.push(Buffer.alloc(BLOCK - remainder, 0));
	}
	// 结束块：两个全零块
	chunks.push(Buffer.alloc(BLOCK * 2, 0));
	const tar = Buffer.concat(chunks);
	return zlib.gzipSync(tar, { level: 6 });
}


/** 产出文件名：<slug>-wp-<时间>.tar.gz（时间 ISO 压平）。 */
export function packFileName(slug, at = Date.now()) {
	const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
	return `${String(slug || "challenge")}-wp-${stamp}.tar.gz`;
}

export default { buildTarGz, packFileName };