/*jshint esversion:11, bitwise:false*/

// ------------------------
// MiniStruct class (schema parsing, encode, decode)
// ------------------------
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
                // encode any as JSON string (length-prefixed)
                const s = JSON.stringify(val);
                const enc = new TextEncoder().encode(s);
                bytes.push(...this.encodeVarint(enc.length), ...enc);
            } else if (field.type === "bool") {
                bytes.push(val ? 1 : 0);
            } else if (field.type === "float") {
                // Use 64-bit float (Float64) to preserve precision for values like 98.6.
                // Many JS numbers can't be exactly represented in 32-bit float, so
                // switching to 64-bit avoids lossy rounding for common decimals.
                const buf = new ArrayBuffer(8);
                new DataView(buf).setFloat64(0, val, true);
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
                // Read 64-bit float (Float64) to match encoding
                obj[field.name] = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true);
                pos += 8;
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
// ------------------------
// Example usage — expanded demo showcasing features
// ------------------------
const schema = `
// Global enum
enum Color {
  RED = 1;
  GREEN = 2;
  BLUE = 3;
}

struct Address {
  string street;
  string city;
  int zip;
}

struct User {
  // inline enum for role
  enum Role { ADMIN = 1; USER = 2; GUEST = 3; }

  string name;
  int id;
  float score;
  bool active;
  Address address;
  Role role;
  Color favoriteColor;
  any metadata; // arbitrary JSON blob
  string bio; // unicode-friendly text
}
`;

const ms = new MiniStruct(schema);

const demo = {
    name: "Joséphine ✨", // unicode
    id: 42,
    score: 98.6,
    active: true,
    address: {
        street: "123 Café Blvd",
        city: "Zürich",
        zip: 8001
    },
    role: "ADMIN", // using enum name
    favoriteColor: "BLUE", // global enum name
    metadata: { tags: ["demo", "测试"], preferences: { theme: "dark", itemsPerPage: 20 } },
    bio: "Loves ☕️, music, and long walks across the byte beach."
};
console.log(
    "Schema minified:\n\n" +
    schema
        .replace(/\/\/.*$/gm, '')                        // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')                // Remove multi-line comments
        .replace(/\s+/g, ' ')                            // Collapse all whitespace to single space
        .replace(/^\s+|\s+$/g, '')                       // Trim leading/trailing whitespace
    + "\n\nInput Data Minified:\n"
);
console.log(
    JSON.stringify(demo)
    + "\n"
);

function bytesToBase64(u8) {
    // btoa expects binary string
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
// Node/browser base64 helpers (fall back to Buffer when btoa/atob absent)
function bytesToBase64_compat(u8) {
    if (typeof btoa === 'function') return bytesToBase64(u8);
    return Buffer.from(u8).toString('base64');
}
function base64ToBytes_compat(b64) {
    if (typeof atob === 'function') return base64ToBytes(b64);
    return Uint8Array.from(Buffer.from(b64, 'base64'));
}

try {
    const encoded = ms.encode("User", demo);
    const encodedBytes = encoded instanceof Uint8Array ? encoded.length : base64ToBytes_compat(encoded).length;
    const encodedBase64 = encoded instanceof Uint8Array ? bytesToBase64_compat(encoded) : encoded;

    console.log("--- Demo: MiniStruct encoding/decoding showcase ---\n");
    console.log("Schema(unminified):\n", schema);
    console.log("Input data object:", demo);
    console.log("Encoded (base64):", encodedBase64);

    const decoded = ms.decode("User", encoded instanceof Uint8Array ? encoded : base64ToBytes_compat(encoded));
    console.log("Decoded object:", decoded);

    const jsonBytes = new TextEncoder().encode(JSON.stringify(demo)).length;
    const efficiency = ((1 - encodedBytes / jsonBytes) * 100).toFixed(2);
    console.log(`Final efficiency: ${efficiency}% (encoded ${encodedBytes} bytes vs JSON ${jsonBytes} bytes)`);
} catch (e) {
    console.error("Demo Error:", e && e.message ? e.message : e);
}
