import test from "node:test";
import assert from "node:assert/strict";
import { sniffType, triageFiles } from "../../lib/triage.js";

const magic = {
	zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
	png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
	pcap: Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]),
	gzip: Buffer.from([0x1f, 0x8b]),
	pdf: Buffer.from("%PDF-1.7", "latin1"),
	pe: Buffer.from("MZ\x90\x00", "latin1")
};

test("triage: 魔数识别常见类型", () => {
	assert.equal(sniffType(magic.zip, "a.bin").type, "zip");
	assert.equal(sniffType(magic.zip, "a.bin").via, "magic");
	assert.equal(sniffType(magic.png, "a.bin").type, "png");
	assert.equal(sniffType(magic.elf, "a.bin").type, "elf");
	assert.equal(sniffType(magic.pcap, "a.bin").type, "pcap");
	assert.equal(sniffType(magic.gzip, "a.bin").type, "gzip");
	assert.equal(sniffType(magic.pdf, "a.bin").type, "pdf");
	assert.equal(sniffType(magic.pe, "a.bin").type, "pe");
});

test("triage: 魔数不明时按扩展名回退", () => {
	const apk = sniffType(Buffer.alloc(0), "app.apk");
	assert.equal(apk.type, "zip");
	assert.equal(apk.via, "extension");
	const pyc = sniffType(Buffer.alloc(0), "x.pyc");
	assert.equal(pyc.type, "pyc");
	const unknown = sniffType(Buffer.alloc(0), "mystery.bin");
	assert.equal(unknown.type, "unknown");
});

test("triage: 多文件汇总并按类型给出下一步", () => {
	const heads = {
		"a.png": magic.png,
		"b.pcap": magic.pcap,
		"c.elf": magic.elf,
		"d.zip": magic.zip
	};
	const result = triageFiles(
		Object.keys(heads).map((name) => ({ name, path: "/tmp/" + name, size: 10 })),
		{ readHead: (file) => heads[file.split("/").pop()] }
	);
	assert.equal(result.ok, true);
	assert.equal(result.files.length, 4);
	assert.equal(result.counts.png, 1);
	assert.equal(result.counts.pcap, 1);
	assert.ok(result.nextSteps.some((step) => step.includes("tshark")));
	assert.ok(result.nextSteps.some((step) => step.includes("checksec")));
});

test("triage: readHead 抛错不影响整体", () => {
	const result = triageFiles([{ name: "x.bin", path: "/tmp/x.bin", size: 1 }], { readHead: () => { throw new Error("boom"); } });
	assert.equal(result.files.length, 1);
	assert.equal(result.files[0].type, "unknown");
});

test("triage: 空输入", () => {
	const result = triageFiles([], {});
	assert.equal(result.files.length, 0);
	assert.ok(result.nextSteps.length > 0);
});