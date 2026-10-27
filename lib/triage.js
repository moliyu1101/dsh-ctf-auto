// dsh-ctf-auto / lib/triage.js —— 附件分诊（纯函数 + 可注入读头）。
//
// 目标：给「工具层」一个统一的附件分诊：按魔数/扩展名判定类型，给出下一步处理提示
// （解压、反编译、流量分析、镜像/内存取证、图片隐写…），不代替真正的分析。

const MAGIC = [
	{ type: "zip", label: "ZIP/Office/JAR 压缩包", hints: ["解压后看目录结构", "注意 zip 注释/伪造扩展名"] },
	{ type: "png", label: "PNG 图片", hints: ["看 LSB/区块/尺寸", "zsteg/binwalk/pngcheck"] },
	{ type: "jpeg", label: "JPEG 图片", hints: ["steghide/EXIF/尾部附加数据"] },
	{ type: "gif", label: "GIF 图片", hints: ["多帧/帧间隐写"] },
	{ type: "pdf", label: "PDF 文档", hints: ["对象流/JS/附件/元数据"] },
	{ type: "elf", label: "ELF 可执行", hints: ["checksec/filestrings", "逆向或 pwn 分诊"] },
	{ type: "pe", label: "PE 可执行", hints: ["查壳/导入表/字符串", "IDA/Ghidra"] },
	{ type: "pcap", label: "PCAP 抓包", hints: ["tshark 协议分层/导出对象", "找 flag 明文或文件流"] },
	{ type: "gzip", label: "GZip 压缩", hints: ["解压后重新分诊"] },
	{ type: "7z", label: "7z 压缩包", hints: ["解压（可能加密）"] },
	{ type: "rar", label: "RAR 压缩包", hints: ["解压（可能加密）"] },
	{ type: "sqlite", label: "SQLite 数据库", hints: ["sqlite3 .tables/查表"] },
	{ type: "java", label: "Java class/JAR 内容", hints: ["反编译 jadx/procyon"] },
	{ type: "pyc", label: "Python 字节码", hints: ["uncompyle6/decompyle3"] },
	{ type: "wasm", label: "WebAssembly", hints: ["wabt 反汇编"] }
];

const EXT_HINTS = {
	".zip": { type: "zip", hints: ["解压后看目录结构"] },
	".png": { type: "png", hints: ["LSB/区块/尺寸"] },
	".jpg": { type: "jpeg", hints: ["EXIF/steghide/尾部数据"] },
	".jpeg": { type: "jpeg", hints: ["EXIF/steghide/尾部数据"] },
	".gif": { type: "gif", hints: ["多帧/帧间"] },
	".pdf": { type: "pdf", hints: ["对象流/JS/附件"] },
	".elf": { type: "elf", hints: ["checksec/strings"] },
	".so": { type: "elf", hints: ["checksec/strings"] },
	".exe": { type: "pe", hints: ["查壳/导入表"] },
	".dll": { type: "pe", hints: ["导入表/字符串"] },
	".pcap": { type: "pcap", hints: ["tshark/导出对象"] },
	".pcapng": { type: "pcap", hints: ["tshark/导出对象"] },
	".gz": { type: "gzip", hints: ["解压"] },
	".tar": { type: "tar", hints: ["tar -tvf 列目录"] },
	".7z": { type: "7z", hints: ["解压"] },
	".rar": { type: "rar", hints: ["解压"] },
	".db": { type: "sqlite", hints: ["sqlite3 查表"] },
	".sqlite": { type: "sqlite", hints: ["sqlite3 查表"] },
	".apk": { type: "zip", hints: ["apk 本质 zip：解压 + apktool/jadx"] },
	".jar": { type: "zip", hints: ["jar 本质 zip：解压 + 反编译"] },
	".class": { type: "java", hints: ["jadx/procyon"] },
	".pyc": { type: "pyc", hints: ["uncompyle6"] },
	".wasm": { type: "wasm", hints: ["wabt 反汇编"] },
	".txt": { type: "text", hints: ["看编码/隐写/摩斯/Base64"] },
	".md": { type: "text", hints: ["读内容"] }
};

const EXT_TO_TYPE = (filename) => {
	const value = String(filename || "").toLowerCase();
	const idx = value.lastIndexOf(".");
	return idx >= 0 ? value.slice(idx) : "";
};

/** 按魔数判定类型；不足则回退扩展名。 */
export function sniffType(head, filename) {
	const buf = head && typeof head.length === "number" ? head : Buffer.alloc(0);
	const bytes = Array.from(buf.slice(0, 16));
	const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
	const ascii = buf.slice(0, 8).toString("latin1");
	const ext = EXT_TO_TYPE(filename);

	const first = MAGIC.find((item) => {
		switch (item.type) {
			case "zip": return hex.startsWith("504b0304") || hex.startsWith("504b0506");
			case "png": return hex.startsWith("89504e47");
			case "jpeg": return hex.startsWith("ffd8ff");
			case "gif": return ascii.startsWith("GIF8");
			case "pdf": return ascii.startsWith("%PDF");
			case "elf": return hex.startsWith("7f454c46");
			case "pe": return ascii.startsWith("MZ");
			case "pcap": return ["d4c3b2a1", "a1b2c3d4", "4d3cb2a1", "a1b23c4d"].some((m) => hex.startsWith(m));
			case "gzip": return hex.startsWith("1f8b");
			case "7z": return hex.startsWith("377abcaf");
			case "rar": return hex.startsWith("52617221");
			case "sqlite": return ascii.startsWith("SQLite format 3");
			case "java": return hex.startsWith("cafebabe");
			case "pyc": return hex.startsWith("550d0d0a") || hex.startsWith("420d0d0a") || hex.startsWith("610d0d0a");
			case "wasm": return hex.startsWith("0061736d");
			default: return false;
		}
	});
	if (first) return { type: first.type, label: first.label, hints: first.hints.slice(), via: "magic" };
	const extHint = EXT_HINTS[ext];
	if (extHint) return { type: extHint.type, label: `${ext.toUpperCase().slice(1)} 文件`, hints: (extHint.hints || []).slice(), via: "extension" };
	return { type: "unknown", label: "未知类型", hints: ["用 file/magic 再确认", "尝试 strings 看明文线索"], via: "unknown" };
}

/**
 * 分诊一组文件。
 * @param {Array<{path:string,name?:string,size?:number}>} files
 * @param {{readHead?: (path:string, bytes:number)=>Buffer|Uint8Array|null}} options
 */
export function triageFiles(files, options = {}) {
	const readHead = typeof options.readHead === "function" ? options.readHead : () => null;
	const items = [];
	for (const file of Array.isArray(files) ? files : []) {
		if (!file || !file.path) continue;
		let head = null;
		try { head = readHead(file.path, 64); } catch { head = null; }
		const sniffed = sniffType(head, file.name || file.path);
		items.push({
			name: String(file.name || file.path),
			path: String(file.path),
			size: Number(file.size) || 0,
			type: sniffed.type,
			label: sniffed.label,
			via: sniffed.via,
			hints: sniffed.hints
		});
	}
	const byType = {};
	for (const item of items) byType[item.type] = (byType[item.type] || 0) + 1;
	const nextSteps = [];
	if (byType.zip) nextSteps.push("解压 zip/jar/apk 后递归分诊（注意注释与伪造扩展名）");
	if (byType.pcap) nextSteps.push("用 tshark 做协议分层/导出对象，找明文 flag 或文件流");
	if (byType.elf || byType.pe) nextSteps.push("可执行文件：checksec/file/strings，再决定逆向或 pwn 路线");
	if (byType.png || byType.jpeg || byType.gif) nextSteps.push("图片：先看 EXIF/尾部附加数据，再试 LSB/帧间隐写");
	if (byType.pyc || byType.java || byType.wasm) nextSteps.push("字节码/中间码：先反编译再读逻辑");
	if (byType.sqlite) nextSteps.push("SQLite：sqlite3 列出表与可疑字段");
	if (nextSteps.length === 0) nextSteps.push("先 strings/十六进制查看，再按题面线索决定路线");
	return { ok: true, files: items, counts: byType, nextSteps };
}

export default { sniffType, triageFiles };