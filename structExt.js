(function (Scratch) {
    'use strict';

    // Base64 helpers
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

    // ---- Paste of MiniStruct class from struct.js (adapted for extension use) ----
    class MiniStruct {
        constructor(schema) {
            this.structs = {};
            this.enums = {}; // global enums
            this.parseSchema(schema);
        }

        // static integer flavor map and helpers
        static INT_TYPES = {
            "int8": { signed: true, bits: 8 },
            "uint8": { signed: false, bits: 8 },
            "int16": { signed: true, bits: 16 },
            "uint16": { signed: false, bits: 16 },
            "int32": { signed: true, bits: 32 },
            "uint32": { signed: false, bits: 32 },
            // default "int" will be int32
            "int": { signed: true, bits: 32 },
        };

        static intrinsicBoundsForInt(typeName) {
            const info = MiniStruct.INT_TYPES[typeName];
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

        static validateRangeAgainstIntrinsic(typeName, rangeMin, rangeMax) {
            const intrinsic = this.intrinsicBoundsForInt(typeName);
            if (!intrinsic) return true;
            const [iMin, iMax] = intrinsic;
            if (rangeMin < iMin || rangeMax > iMax) {
                throw new Error(`Schema error: range [${rangeMin},${rangeMax}] outside intrinsic bounds of ${typeName} (${iMin}..${iMax})`);
            }
            return true;
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
                const rawType = tokens[0];
                // parse integer flavors and optional ranges like uint8[0,255]
                let type;
                const intMatch = rawType.match(/^(int|uint8|int8|uint16|int16|uint32|int32|uint8|int)\s*(?:\[\s*([^,\]]+)\s*,\s*([^\]]+)\s*\])?$/);
                if (intMatch) {
                    const name = intMatch[1];
                    const rangeA = intMatch[2];
                    const rangeB = intMatch[3];
                    if (rangeA !== undefined && rangeB !== undefined) {
                        const rmin = Number(rangeA);
                        const rmax = Number(rangeB);
                        if (!Number.isInteger(rmin) || !Number.isInteger(rmax)) throw new Error(`Schema parse error: invalid integer range for ${rawType}`);
                        // validate range against intrinsic bounds
                        try { this.constructor.validateRangeAgainstIntrinsic(name, rmin, rmax); } catch (e) { throw new Error(e.message + ` (field ${structName}.${tokens[1]})`); }
                        type = { prim: 'int', name, range: [rmin, rmax] };
                    } else {
                        type = { prim: 'int', name, range: null };
                    }
                } else {
                    type = rawType;
                }
                const name = tokens[1];
                fields.push({ type, name, default: defVal, localEnums });
            });

            return { fields, localEnums };
        }

        // Descriptive validation used during encode to produce path-aware errors
        validateValueForField(fieldType, value, path, localEnums) {
            // integer object form
            if (typeof fieldType === 'object' && fieldType.prim === 'int') {
                if (!Number.isInteger(value)) throw new Error(`Type violation at "${path}": Expected integer (${fieldType.name}), got ${typeof value} (${JSON.stringify(value)})`);
                if (fieldType.range) {
                    const [rmin, rmax] = fieldType.range;
                    if (value < rmin || value > rmax) throw new Error(`Type violation at "${path}": integer ${value} outside declared range [${rmin},${rmax}]`);
                } else {
                    const bounds = this.constructor.intrinsicBoundsForInt(fieldType.name);
                    if (bounds) {
                        const [iMin, iMax] = bounds;
                        if (value < iMin || value > iMax) throw new Error(`Type violation at "${path}": integer ${value} outside intrinsic bounds of ${fieldType.name} (${iMin}..${iMax})`);
                    }
                }
                return true;
            }

            // string-like tokens
            if (typeof fieldType === 'string') {
                if (fieldType === 'int') {
                    if (!Number.isInteger(value)) throw new Error(`Type violation at "${path}": Expected integer, got ${typeof value} (${JSON.stringify(value)})`);
                    return true;
                }
                if (fieldType === 'float' || fieldType === 'float32' || fieldType === 'float64') {
                    if (typeof value !== 'number') throw new Error(`Type violation at "${path}": Expected float, got ${typeof value} (${JSON.stringify(value)})`);
                    return true;
                }
                if (fieldType === 'bool') {
                    if (typeof value !== 'boolean') throw new Error(`Type violation at "${path}": Expected bool, got ${typeof value} (${JSON.stringify(value)})`);
                    return true;
                }
                if (fieldType === 'string') {
                    if (typeof value !== 'string') throw new Error(`Type violation at "${path}": Expected string, got ${typeof value} (${JSON.stringify(value)})`);
                    return true;
                }
                if (fieldType === 'any') return true;

                // enum check (local first)
                if (localEnums && localEnums[fieldType]) {
                    const e = localEnums[fieldType];
                    if (typeof value === 'string') {
                        if (!(value in e.nameToVal)) throw new Error(`Type violation at "${path}": Expected enum ${fieldType} one of [${Object.keys(e.nameToVal).join(', ')}], got ${JSON.stringify(value)}`);
                    } else if (typeof value === 'number') {
                        if (!(value in e.valToName)) throw new Error(`Type violation at "${path}": Expected enum ${fieldType} numeric value one of [${Object.keys(e.valToName).join(', ')}], got ${value}`);
                    } else {
                        throw new Error(`Type violation at "${path}": Expected enum ${fieldType}, got ${typeof value} (${JSON.stringify(value)})`);
                    }
                    return true;
                }

                if (this.enums[fieldType]) {
                    const e = this.enums[fieldType];
                    if (typeof value === 'string') {
                        if (!(value in e.nameToVal)) throw new Error(`Type violation at "${path}": Expected enum ${fieldType} one of [${Object.keys(e.nameToVal).join(', ')}], got ${JSON.stringify(value)}`);
                    } else if (typeof value === 'number') {
                        if (!(value in e.valToName)) throw new Error(`Type violation at "${path}": Expected enum ${fieldType} numeric value one of [${Object.keys(e.valToName).join(', ')}], got ${value}`);
                    } else {
                        throw new Error(`Type violation at "${path}": Expected enum ${fieldType}, got ${typeof value} (${JSON.stringify(value)})`);
                    }
                    return true;
                }

                // struct fallback
                if (this.structs[fieldType]) {
                    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Type violation at "${path}": Expected struct ${fieldType}, got ${typeof value} (${JSON.stringify(value)})`);
                    return true;
                }

                throw new Error(`Unknown type: ${fieldType} at ${path}`);
            }

            // fallback allow
            return true;
        }

        validateAgainstType(val, type, localEnums) {
            // support the older string-typed type names
            if (typeof type === 'string') {
                if (type === 'int') return (typeof val === 'number' || typeof val === 'bigint') && Number.isFinite(Number(val)) && Math.floor(Number(val)) === Number(val);
                if (type === 'float' || type === 'float64' || type === 'float32') return typeof val === 'number' && Number.isFinite(val);
                if (type === 'bool') return typeof val === 'boolean';
                if (type === 'string') return typeof val === 'string';
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

                if (this.structs[type]) return val !== null && typeof val === 'object';

                throw new Error("Unknown type: " + type);
            }

            // object-shaped type (e.g., { prim: 'int', name, range })
            if (typeof type === 'object' && type.prim === 'int') {
                if (!Number.isInteger(val)) return false;
                if (type.range) {
                    const [rmin, rmax] = type.range;
                    return val >= rmin && val <= rmax;
                }
                // apply intrinsic bounds if available
                const bounds = this.constructor.intrinsicBoundsForInt(type.name);
                if (!bounds) return true;
                const [iMin, iMax] = bounds;
                return val >= iMin && val <= iMax;
            }

            // fallback: arrays and structs handled elsewhere in the newer API
            return true;
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

        // Fixed-width integer and float helpers (little-endian)
        writeFixedInt(value, bits, signed) {
            const byteLen = bits / 8;
            const buf = new ArrayBuffer(byteLen);
            const dv = new DataView(buf);
            if (bits === 8) {
                if (signed) dv.setInt8(0, value);
                else dv.setUint8(0, value);
            } else if (bits === 16) {
                if (signed) dv.setInt16(0, value, true);
                else dv.setUint16(0, value, true);
            } else if (bits === 32) {
                if (signed) dv.setInt32(0, value, true);
                else dv.setUint32(0, value, true);
            } else {
                throw new Error('Unsupported integer width: ' + bits);
            }
            return new Uint8Array(buf);
        }

        readFixedInt(buf, pos, bits, signed) {
            const byteLen = bits / 8;
            const dv = new DataView(buf.buffer, buf.byteOffset + pos, byteLen);
            let v;
            if (bits === 8) v = signed ? dv.getInt8(0) : dv.getUint8(0);
            else if (bits === 16) v = signed ? dv.getInt16(0, true) : dv.getUint16(0, true);
            else if (bits === 32) v = signed ? dv.getInt32(0, true) : dv.getUint32(0, true);
            else throw new Error('Unsupported integer width: ' + bits);
            return [v, pos + byteLen];
        }

        writeFloat32(val) {
            const buf = new ArrayBuffer(4);
            new DataView(buf).setFloat32(0, val, true);
            return new Uint8Array(buf);
        }

        writeFloat64(val) {
            const buf = new ArrayBuffer(8);
            new DataView(buf).setFloat64(0, val, true);
            return new Uint8Array(buf);
        }

        readFloat32(buf, pos) {
            const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
            return [dv.getFloat32(0, true), pos + 4];
        }

        readFloat64(buf, pos) {
            const dv = new DataView(buf.buffer, buf.byteOffset + pos, 8);
            return [dv.getFloat64(0, true), pos + 8];
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
                // produce descriptive, path-aware errors
                this.validateValueForField(field.type, val, `${typeName}.${field.name}`, struct.localEnums);

                // encode by type
                // integer flavors: support type object { prim:'int', name, range }
                if ((typeof field.type === 'object' && field.type.prim === 'int') || field.type === "int") {
                    // validate range if present
                    if (typeof field.type === 'object' && field.type.range) {
                        const [rmin, rmax] = field.type.range;
                        if (val < rmin || val > rmax) throw new Error(`Value for ${field.name} out of declared range ${rmin}..${rmax}`);
                    }
                    // determine integer width and signedness
                    let typeName = typeof field.type === 'object' ? field.type.name : 'int';
                    const info = MiniStruct.INT_TYPES[typeName] || MiniStruct.INT_TYPES['int'];
                    if (info) {
                        bytes.push(...this.writeFixedInt(val, info.bits, info.signed));
                    } else {
                        // fallback to varint for unknown sizes
                        bytes.push(...this.encodeVarint(val));
                    }
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
                } else if (field.type === "float" || field.type === 'float64') {
                    bytes.push(...this.writeFloat64(val));
                } else if (field.type === 'float32') {
                    bytes.push(...this.writeFloat32(val));
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

                if ((typeof field.type === 'object' && field.type.prim === 'int') || field.type === "int") {
                    let typeName = (typeof field.type === 'object') ? field.type.name : 'int';
                    const info = MiniStruct.INT_TYPES[typeName] || MiniStruct.INT_TYPES['int'];
                    if (info) {
                        [obj[field.name], pos] = this.readFixedInt(buf, pos, info.bits, info.signed);
                    } else {
                        [obj[field.name], pos] = this.decodeVarint(buf, pos);
                    }
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
                } else if (field.type === "float" || field.type === 'float64') {
                    [obj[field.name], pos] = this.readFloat64(buf, pos);
                } else if (field.type === 'float32') {
                    [obj[field.name], pos] = this.readFloat32(buf, pos);
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

        setSchema({ SCHEMA }) {
            this.lastError = '';
            this.schemaText = SCHEMA;
            try {
                this.ms = new MiniStruct(SCHEMA);
            } catch (e) {
                this.lastError = e.message;
                throw e;
            }
        }

        encodeToBase64({ STRUCT, STRUCTTYPE }) {
            this.lastError = '';
            if (!this.ms) { this.lastError = 'Schema not set'; throw new Error('Schema not set'); }
            const obj = JSON.parse(STRUCT);
            const encoded = this.ms.encode(STRUCTTYPE, obj);
            return bytesToBase64(encoded);
        }

        decodeFromBase64({ B64, STRUCTTYPE }) {
            this.lastError = '';
            if (!this.ms) { this.lastError = 'Schema not set'; throw new Error('Schema not set'); }
            const bytes = base64ToBytes(B64);
            const obj = this.ms.decode(STRUCTTYPE, bytes);
            return JSON.stringify(obj);
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