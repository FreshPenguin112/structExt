(function(Scratch){
		'use strict';

		// Base64 helpers
		function bytesToBase64(u8) {
				let s = "";
				for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
				return btoa(s);
		}
		function base64ToBytes(b64) {
				const s = atob(b64);
				const arr = new Uint8Array(s.length);
				for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
				return arr;
		}

		// ---- Paste of MiniStruct class from struct.js (adapted for extension use) ----
		// MiniStruct.js with enum support
		class MiniStruct {
			constructor(schema) {
				this.structs = {};
				this.enums = {}; // global enums
				this.parseSchema(schema);
			}

			parseSchema(schema) {
				// remove line comments but preserve spacing for brace matching
				schema = schema.replace(/\/\/.*$/gm, "");

				// Parse structs by scanning and matching braces so nested blocks (like inline enums) are handled
				let i = 0;
				while (true) {
					const sIndex = schema.indexOf('struct ', i);
					if (sIndex === -1) break;
					// find name start
					const nameStart = sIndex + 'struct '.length;
					// find the next '{' after the name
					const braceIndex = schema.indexOf('{', nameStart);
					if (braceIndex === -1) break; // malformed
					const name = schema.slice(nameStart, braceIndex).trim().split(/\s+/)[0];
					// find matching closing brace
					let depth = 0;
					let j = braceIndex;
					for (; j < schema.length; j++) {
						const ch = schema[j];
						if (ch === '{') depth++;
						else if (ch === '}') {
							depth--;
							if (depth === 0) break;
						}
					}
					if (depth !== 0) break; // unbalanced braces
					const body = schema.slice(braceIndex + 1, j);
					this.structs[name] = this.parseStructBody(body, name);
					// replace the parsed struct portion with spaces so global enum parsing won't see inline enums
					const replaceLen = j - sIndex + 1;
					schema = schema.slice(0, sIndex) + ' '.repeat(replaceLen) + schema.slice(j + 1);
					i = sIndex + 1;
				}

				// Parse remaining global enums (those not inside structs)
				let enumRegex = /enum (\w+) \{([^}]*)\}/g;
				let match;
				while ((match = enumRegex.exec(schema))) {
					const [, name, body] = match;
					this.enums[name] = this.parseEnumBody(body);
				}
			}

			parseEnumBody(body) {
				const nameToVal = {};
				const valToName = {};
				let counter = 0;

				body.split(";").forEach(part => {
					part = part.trim();
					if (!part) return;
					const m = part.match(/(\w+)(?:\s*=\s*(\d+))?/);
					if (m) {
						const [, key, valStr] = m;
						const val = valStr !== undefined ? parseInt(valStr, 10) : counter;
						counter = val + 1;
						nameToVal[key] = val;
						valToName[val] = key;
					}
				});

				return { nameToVal, valToName };
			}

			parseStructBody(body, structName) {
				const fields = [];

				// Inline enums
				let localEnums = {};
				let enumRegex = /enum (\w+) \{([^}]*)\}/g;
				let match;
				while ((match = enumRegex.exec(body))) {
					const [, name, ebody] = match;
					localEnums[name] = this.parseEnumBody(ebody);
				}

				// Remove inline enum blocks (we already parsed them) to avoid their internal semicolons
				const bodyClean = body.replace(/enum (\w+) \{[^}]*\}/g, "");

				// Fields
				bodyClean.split(";").forEach(part => {
					part = part.trim();
					if (!part) return;

					let [decl, defVal] = part.split(":").map(s => s.trim());
					if (!decl) return;
					const tokens = decl.split(/\s+/).filter(Boolean);
					if (tokens.length < 2) return;
					const type = tokens[0];
					const name = tokens[1];
					fields.push({ type, name, default: defVal, localEnums });
				});

				return { fields, localEnums };
			}

			validateAgainstType(val, type, localEnums) {
				// core types
				if (["int", "float", "bool", "string"].includes(type)) return true;
				if (type === 'any') return true;

				// enum check (local first)
				if (localEnums[type]) {
					return (
						typeof val === "string" ? val in localEnums[type].nameToVal :
						typeof val === "number" && val in localEnums[type].valToName
					);
				}
				if (this.enums[type]) {
					return (
						typeof val === "string" ? val in this.enums[type].nameToVal :
						typeof val === "number" && val in this.enums[type].valToName
					);
				}

				// struct type fallback
				if (this.structs[type]) return true;

				throw new Error("Unknown type: " + type);
			}

			encodeVarint(num) {
				const bytes = [];
				while (num > 127) {
					bytes.push((num & 0x7f) | 0x80);
					num >>>= 7;
				}
				bytes.push(num);
				return Uint8Array.from(bytes);
			}

			decodeVarint(buf, offset) {
				let num = 0, shift = 0, pos = offset;
				while (true) {
					let b = buf[pos++];
					num |= (b & 0x7f) << shift;
					if ((b & 0x80) === 0) break;
					shift += 7;
				}
				return [num, pos];
			}

			encode(typeName, obj) {
				const struct = this.structs[typeName];
				if (!struct) throw new Error("Unknown struct: " + typeName);

				const bytes = [];
				for (const field of struct.fields) {
					let val = obj[field.name] ?? field.default;
					if (val === undefined) continue;
					if (!this.validateAgainstType(val, field.type, struct.localEnums)) {
						throw new Error(`Invalid value for field ${field.name}`);
					}

					// encode by type
					if (field.type === "int") {
						bytes.push(...this.encodeVarint(val));
					} else if (field.type === "string") {
						const enc = new TextEncoder().encode(val);
						bytes.push(...this.encodeVarint(enc.length), ...enc);
					} else if (field.type === "any") {
						const s = JSON.stringify(val);
						const enc = new TextEncoder().encode(s);
						bytes.push(...this.encodeVarint(enc.length), ...enc);
					} else if (field.type === "bool") {
						bytes.push(val ? 1 : 0);
					} else if (field.type === "float") {
						const buf = new ArrayBuffer(4);
						new DataView(buf).setFloat32(0, val, true);
						bytes.push(...new Uint8Array(buf));
					} else if (struct.localEnums[field.type] || this.enums[field.type]) {
						const e = struct.localEnums[field.type] || this.enums[field.type];
						const num = typeof val === "string" ? e.nameToVal[val] : val;
						bytes.push(...this.encodeVarint(num));
					} else if (this.structs[field.type]) {
						const enc = this.encode(field.type, val);
						bytes.push(...this.encodeVarint(enc.length), ...enc);
					}
				}
				return Uint8Array.from(bytes);
			}

			decode(typeName, buf, offset = 0) {
				const struct = this.structs[typeName];
				if (!struct) throw new Error("Unknown struct: " + typeName);
				const obj = {};
				let pos = offset;

				for (const field of struct.fields) {
					if (pos >= buf.length) break;

					if (field.type === "int") {
						[obj[field.name], pos] = this.decodeVarint(buf, pos);
					} else if (field.type === "string") {
						let [len, p2] = this.decodeVarint(buf, pos);
						pos = p2;
						obj[field.name] = new TextDecoder().decode(buf.slice(pos, pos + len));
						pos += len;
					} else if (field.type === "any") {
						let [len, p2] = this.decodeVarint(buf, pos);
						pos = p2;
						const s = new TextDecoder().decode(buf.slice(pos, pos + len));
						pos += len;
						try { obj[field.name] = JSON.parse(s); } catch { obj[field.name] = s; }
					} else if (field.type === "bool") {
						obj[field.name] = !!buf[pos++];
					} else if (field.type === "float") {
						obj[field.name] = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
						pos += 4;
					} else if (struct.localEnums[field.type] || this.enums[field.type]) {
						let [num, p2] = this.decodeVarint(buf, pos);
						pos = p2;
						const e = struct.localEnums[field.type] || this.enums[field.type];
						obj[field.name] = e.valToName[num] ?? num;
					} else if (this.structs[field.type]) {
						let [len, p2] = this.decodeVarint(buf, pos);
						pos = p2;
						obj[field.name] = this.decode(field.type, buf.slice(pos, pos + len));
						pos += len;
					}
				}

				return obj;
			}
		}

		// ---- TurboWarp / Scratch extension wrapper ----
		class StructExtension {
			constructor() {
				this.vm = null;
				this.ms = null; // MiniStruct instance
				this.schemaText = '';
				this.lastError = '';
			}

			getInfo() {
				return {
					id: 'structext',
					name: 'Struct',
					blocks: [
						{
							opcode: 'setSchema',
							blockType: Scratch.BlockType.COMMAND,
							text: 'set schema [SCHEMA]',
							arguments: { SCHEMA: { type: Scratch.ArgumentType.STRING, defaultValue: 'struct My { int id; string name; }' } }
						},
						{
							opcode: 'encodeToBase64',
							blockType: Scratch.BlockType.REPORTER,
							text: 'encode [STRUCT] with schema [STRUCTTYPE]',
							arguments: {
								STRUCT: { type: Scratch.ArgumentType.STRING, defaultValue: '{}' },
								STRUCTTYPE: { type: Scratch.ArgumentType.STRING, defaultValue: 'My' }
							}
						},
						{
							opcode: 'decodeFromBase64',
							blockType: Scratch.BlockType.REPORTER,
							text: 'decode base64 [B64] as [STRUCTTYPE]',
							arguments: {
								B64: { type: Scratch.ArgumentType.STRING, defaultValue: '' },
								STRUCTTYPE: { type: Scratch.ArgumentType.STRING, defaultValue: 'My' }
							}
						},
						{
							opcode: 'listStructs',
							blockType: Scratch.BlockType.REPORTER,
							text: 'list structs'
						},
						{
							opcode: 'getLastError',
							blockType: Scratch.BlockType.REPORTER,
							text: 'last error'
						}
					],
					menus: {}
				};
			}

			setSchema({SCHEMA}) {
				this.lastError = '';
				try {
					this.schemaText = SCHEMA;
					this.ms = new MiniStruct(SCHEMA);
				} catch (e) {
					this.lastError = e.message;
				}
			}

			encodeToBase64({STRUCT, STRUCTTYPE}) {
				this.lastError = '';
				if (!this.ms) { this.lastError = 'Schema not set'; return ''; }
				try {
					const obj = JSON.parse(STRUCT);
					const encoded = this.ms.encode(STRUCTTYPE, obj);
					return bytesToBase64(encoded);
				} catch (e) {
					this.lastError = e.message;
					return '';
				}
			}

			decodeFromBase64({B64, STRUCTTYPE}) {
				this.lastError = '';
				if (!this.ms) { this.lastError = 'Schema not set'; return ''; }
				try {
					const bytes = base64ToBytes(B64);
					const obj = this.ms.decode(STRUCTTYPE, bytes);
					return JSON.stringify(obj);
				} catch (e) {
					this.lastError = e.message;
					return '';
				}
			}

			listStructs() {
				if (!this.ms) return '';
				return Object.keys(this.ms.structs).join(',');
			}

			getLastError() {
				return this.lastError || '';
			}
		}

		// Register extension
		if (typeof Scratch !== 'undefined' && Scratch.extensions) {
			Scratch.extensions.register(new StructExtension());
		}

})(Scratch)