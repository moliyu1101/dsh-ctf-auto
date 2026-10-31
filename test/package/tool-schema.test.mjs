import test from "node:test";
import assert from "node:assert/strict";
import { host } from "../helpers/host.mjs";

// DSH validates each tool's declared output schema against a JSON Schema subset
// while the plugin mounts. A violation aborts apply(), so the whole plugin
// disappears (no Web route, no tools) instead of failing one tool. Tool
// parameters are passed through untouched, hence only `output.schema` is
// checked here. These two rules are the ones real upgrades tripped over:
//   1. `required` naming a key that is absent from `properties`;
//   2. keywords outside the subset (anyOf/allOf/$ref/pattern/... are rejected;
//      oneOf is the supported alternative).
const CONSTRAINT_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ONE_OF_SIBLINGS = ["properties", "required", "additionalProperties", "items", "enum", "const"];

function checkSchema(node, path, violations) {
	if (!node || typeof node !== "object" || Array.isArray(node)) {
		violations.push(`${path} must be a schema object`);
		return;
	}
	for (const key of Object.keys(node)) {
		if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
	}
	if ("description" in node && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
	if ("title" in node && typeof node.title !== "string") violations.push(`${path}.title must be a string`);

	const hasType = Object.hasOwn(node, "type");
	const hasOneOf = Object.hasOwn(node, "oneOf");
	if (hasType && hasOneOf) {
		violations.push(`${path} cannot declare both type and oneOf`);
		return;
	}
	if (!hasType && !hasOneOf) {
		violations.push(`${path} requires type or oneOf`);
		return;
	}
	if (hasOneOf) {
		if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) violations.push(`${path}.oneOf must be a non-empty array`);
		else node.oneOf.forEach((schema, index) => checkSchema(schema, `${path}.oneOf[${index}]`, violations));
		for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
		return;
	}
	if (!SCHEMA_TYPES.has(node.type)) {
		violations.push(`${path}.type is not a supported type`);
		return;
	}
	if (node.type === "object") {
		const properties = node.properties;
		if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
			violations.push(`${path}.properties must be a schema record`);
		}
		if (Object.hasOwn(node, "required")) {
			if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string")) {
				violations.push(`${path}.required must be an array of strings`);
			} else {
				for (const key of node.required) {
					if (!properties || !Object.hasOwn(properties, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
				}
			}
		}
		if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
			violations.push(`${path}.additionalProperties must be a boolean`);
		}
		if (properties && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [key, schema] of Object.entries(properties)) checkSchema(schema, `${path}.properties.${key}`, violations);
		}
	}
	if (Object.hasOwn(node, "items")) checkSchema(node.items, `${path}.items`, violations);
}

test("every registered tool schema stays inside the JSON Schema subset DSH accepts", async (t) => {
	const { tools } = await host(t, { concurrency: 1 });
	assert.ok(tools.size > 0, "the plugin should register at least one tool");

	const violations = [];
	for (const [name, tool] of tools) {
		const schema = tool?.output?.schema;
		if (schema) checkSchema(schema, `${name}.output.schema`, violations);
	}
	assert.deepEqual(violations, [], `tool schemas DSH would reject at mount:\n${violations.join("\n")}`);
});

test("the schema guard itself rejects the two regressions seen in upgrades", () => {
	const missing = [];
	checkSchema({ type: "object", properties: {}, required: ["ok"] }, "sample", missing);
	assert.match(missing.join("\n"), /required names "ok" which is not in properties/);

	const anyOf = [];
	checkSchema({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } }, "sample", anyOf);
	assert.match(anyOf.join("\n"), /anyOf is not a supported keyword/);

	const fine = [];
	checkSchema({ type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["value"] }, "sample", fine);
	assert.deepEqual(fine, []);
});