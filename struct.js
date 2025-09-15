// ========================
// MiniStruct.js - Full Version
// Features: multi-typed arrays, ranged ints, integer flavors, path-aware errors,
//           any type, unicode-safe strings, efficiency measurement
// ========================

// ------------------------
// Low-level helpers
// ------------------------
function encodeVarint(num) {
    const bytes = [];
    let n = num >>> 0;
    while (n > 127) {
        bytes.push((n & 0x7F) | 0x80);
        n >>>= 7;
    }
    bytes.push(n);
    return Uint8Array.from(bytes);
}

function decodeVarint(bytes, offset = 0) {
    let result = 0, shift = 0, i = offset;
    while (true) {
        const b = bytes[i++];
        result |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result >>> 0, length: i - offset };
}

function encodeString(str) {
    const encoder = new TextEncoder();
    const strBytes = encoder.encode(str);
    return new Uint8Array([...encodeVarint(strBytes.length), ...strBytes]);
}

function decodeString(bytes, offset) {
    const { value: len, length: lenBytes } = decodeVarint(bytes, offset);
    const decoder = new TextDecoder();
    const str = decoder.decode(bytes.slice(offset + lenBytes, offset + lenBytes + len));
    return { value: str, length: lenBytes + len };
}

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

// ------------------------
// Type system helpers
// ------------------------
const INT_TYPES = {
    "int8": { signed: true, bits: 8 },
    "uint8": { signed: false, bits: 8 },
    "int16": { signed: true, bits: 16 },
    "uint16": { signed: false, bits: 16 },
    "int32": { signed: true, bits: 32 },
    "uint32": { signed: false, bits: 32 },
    // default "int" will be int32
    "int": { signed: true, bits: 32 },
};

function intrinsicBoundsForInt(typeName) {
    const info = INT_TYPES[typeName];
    if (!info) return null;
    if (info.signed) {
        const min = -(2 ** (info.bits - 1));
        const max = (2 ** (info.bits - 1)) - 1;
        return [min, max];
    } else {
        const min = 0;
        const max = (2 ** info.bits) - 1;
        return [min, max];
    }
}

// Validate that a numeric range fits within intrinsic bounds
function validateRangeAgainstIntrinsic(typeName, rangeMin, rangeMax) {
    const intrinsic = intrinsicBoundsForInt(typeName);
    if (!intrinsic) return true; // not an integer-flavored type
    const [iMin, iMax] = intrinsic;
    if (rangeMin < iMin || rangeMax > iMax) {
        throw new Error(`Schema error: range [${rangeMin},${rangeMax}] outside intrinsic bounds of ${typeName} (${iMin}..${iMax})`);
    }
    return true;
}

// ------------------------
// Type parser
// ------------------------

// Parse a type expression string and return a normalized typeDef
// typeDef examples:
// { kind: "primitive", name: "int", bits:32, signed:true, range:[min,max] }
// { kind: "string" }
// { kind: "float" }
// { kind: "bool" }
// { kind: "any" }
// { kind: "struct", name: "Address" }
// { kind: "array", elementTypes: [ typeDef1, typeDef2, ... ] }
// For array elementTypes === null it means "any-typed-array"
function parseTypeExpr(typeExprRaw) {
    const t = typeExprRaw.trim();

    // array bracketed: arr[...]
    if (/^arr\s*\[/.test(t)) {
        // extract between brackets
        const inner = t.replace(/^arr\s*\[\s*/, "").replace(/\s*\]\s*$/, "");
        if (inner.trim() === "") {
            // arr[] empty: means array of any? treat as array of any-typed elements (disallowed for multi-typed 'any' rules later)
            return { kind: "array", elementTypes: null };
        }
        // split top-level commas (no nested parsing complexity because we only allow nested arr[...] tokens)
        // we'll implement a small parser that handles nested brackets
        const elems = [];
        let cur = "";
        let depth = 0;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === "[") { depth++; cur += ch; continue; }
            if (ch === "]") { depth--; cur += ch; continue; }
            if (ch === "," && depth === 0) {
                elems.push(cur.trim()); cur = ""; continue;
            }
            cur += ch;
        }
        if (cur.trim() !== "") elems.push(cur.trim());
        const elementTypes = elems.map(tok => {
            // special case: 'arr' alone inside arr[...] means "any-typed-array"
            if (tok === "arr") return { kind: "array", elementTypes: null };
            // if token starts with 'arr[' it's a nested array type
            if (/^arr\s*\[/.test(tok)) return parseTypeExpr(tok);
            // else parse possible ranged int like int[1,10] or primitive
            return parseNonArrayType(tok);
        });

        // rule: multi-typed arrays must not include any 'any' type
        for (const et of elementTypes) {
            if (containsAnyType(et)) throw new Error("Schema error: 'any' type is not allowed inside multi-typed arrays");
        }

        return { kind: "array", elementTypes };
    }

    // shorthand arr type as "arr int" (we'll be called with portion before name)
    if (/^arr\s+/.test(t)) {
        const remainder = t.replace(/^arr\s+/, "").trim();
        // remainder must be parseable as a non-array type; convert into array of that single type
        if (remainder === 'any') {
            return { kind: 'array', elementTypes: null };
        }
        const innerType = parseNonArrayType(remainder);
        return { kind: "array", elementTypes: [innerType] };
    }

    // else normal non-array type
    return parseNonArrayType(t);
}

function parseNonArrayType(tok) {
    // detect ranged integer syntax: like int[1,10] or uint8[0,255]
    const m = tok.match(/^(\w+)\s*(\[\s*([^\]]+)\s*\])?$/);
    if (!m) throw new Error("Schema parse error: invalid type token: " + tok);
    const name = m[1];
    const bracket = m[2];
    const bracketInner = m[3];

    if (name === "string") return { kind: "string" };
    if (name === "float") return { kind: "float" };
    if (name === "bool") return { kind: "bool" };
    if (name === "any") return { kind: "any" };
    if (INT_TYPES[name]) {
        // possible range
        if (bracket) {
            // range like [min,max]
            const parts = bracketInner.split(",").map(s => s.trim());
            if (parts.length !== 2) throw new Error("Schema parse error: invalid range for " + name);
            const rmin = Number(parts[0]);
            const rmax = Number(parts[1]);
            if (!Number.isInteger(rmin) || !Number.isInteger(rmax)) throw new Error("Schema parse error: ranges must be integers for " + name);
            validateRangeAgainstIntrinsic(name, rmin, rmax);
            return { kind: "primitive", prim: "int", name, bits: INT_TYPES[name].bits, signed: INT_TYPES[name].signed, range: [rmin, rmax] };
        } else {
            // no custom range -> intrinsic bounds apply at validation time but we store type flavor
            return { kind: "primitive", prim: "int", name, bits: INT_TYPES[name].bits, signed: INT_TYPES[name].signed, range: null };
        }
    }
    // default integer generic 'int' support: also allow int[1,10] (already covered by INT_TYPES since 'int' present)
    // unknown word -> treat as struct reference
    return { kind: "struct", name };
}

function containsAnyType(typeDef) {
    if (!typeDef) return false;
    if (typeDef.kind === "any") return true;
    if (typeDef.kind === "array") {
        if (typeDef.elementTypes === null) return false; // "any-typed-array" is allowed as element of multi-type arrays? (we allow)
        for (const e of typeDef.elementTypes) if (containsAnyType(e)) return true;
        return false;
    }
    // primitive and struct not any
    return false;
}

// ------------------------
// Validation against a typeDef (throws descriptive error with path)
// ------------------------
function validateAgainstType(typeDef, value, path) {
    if (typeDef.kind === "any") {
        // accept anything
        return true;
    }
    if (typeDef.kind === "string") {
        if (typeof value !== "string") {
            throw new Error(`Type violation at "${path}": Expected string, got ${typeof value} (${JSON.stringify(value)})`);
        }
        return true;
    }
    if (typeDef.kind === "float") {
        if (typeof value !== "number") {
            throw new Error(`Type violation at "${path}": Expected float, got ${typeof value} (${JSON.stringify(value)})`);
        }
        return true;
    }
    if (typeDef.kind === "bool") {
        if (typeof value !== "boolean") {
            throw new Error(`Type violation at "${path}": Expected bool, got ${typeof value} (${JSON.stringify(value)})`);
        }
        return true;
    }
    if (typeDef.kind === "primitive" && typeDef.prim === "int") {
        if (!Number.isInteger(value)) throw new Error(`Type violation at "${path}": Expected integer (${typeDef.name}), got ${typeof value} (${JSON.stringify(value)})`);
        // if a custom range specified:
        if (typeDef.range) {
            const [rmin, rmax] = typeDef.range;
            if (value < rmin || value > rmax) {
                throw new Error(`Type violation at "${path}": integer ${value} outside declared range [${rmin},${rmax}]`);
            }
        } else {
            // apply intrinsic bounds
            const [iMin, iMax] = intrinsicBoundsForInt(typeDef.name);
            if (value < iMin || value > iMax) {
                throw new Error(`Type violation at "${path}": integer ${value} outside intrinsic bounds of ${typeDef.name} (${iMin}..${iMax})`);
            }
        }
        return true;
    }
    if (typeDef.kind === "struct") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error(`Type violation at "${path}": Expected struct ${typeDef.name}, got ${typeof value} (${JSON.stringify(value)})`);
        }
        return true; // deeper validation happens at encode call when nested struct processed
    }
    if (typeDef.kind === "array") {
        if (!Array.isArray(value)) {
            throw new Error(`Type violation at "${path}": Expected array, got ${typeof value} (${JSON.stringify(value)})`);
        }
        // element types checked per element during encode
        return true;
    }

    throw new Error(`Type system error: unknown typeDef at ${path}`);
}

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
console.log(btoa(schema));
console.log(JSON.stringify(demo));
/*
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

  console.log("--- Demo: MiniStruct encoding/decoding showcase ---");
  console.log("Schema:\n", schema);
  console.log("Original object:", demo);
  console.log("Encoded (base64):", encodedBase64);

  const decoded = ms.decode("User", encoded instanceof Uint8Array ? encoded : base64ToBytes_compat(encoded));
  console.log("Decoded object:", decoded);

  const jsonBytes = new TextEncoder().encode(JSON.stringify(demo)).length;
  const efficiency = ((1 - encodedBytes / jsonBytes) * 100).toFixed(2);
  console.log(`Final efficiency: ${efficiency}% (encoded ${encodedBytes} bytes vs JSON ${jsonBytes} bytes)`);
} catch (e) {
  console.error("Demo Error:", e && e.message ? e.message : e);
}
*/