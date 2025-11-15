/*jshint esversion:11, bitwise:false*/

// MiniStruct class (schema parsing, encode, decode) with:
// - recursive struct references
// - optional properties using `Type? name;` syntax
// - arrays using `Type[]` (can nest arbitrarily), arrays of `any` allowed
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

    // ------------------------
    // Schema parsing
    // ------------------------
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

    // parse a type string like:
    //   uint8[0,255]    -> object int descriptor
    //   Address         -> string "Address" (struct/enum reference)
    //   Address[]       -> { prim:'array', elem: 'Address' }
    //   int[][]         -> nested arrays
    //   string?         -> optional flag is handled by parseStructBody; here we return only the type descriptor
    // Returns { typeDesc, optional }
    parseTypeString(rawType, structName) {
        let t = rawType.trim();
        // detect optional marker ? appended to the type
        let optional = false;
        if (t.endsWith('?')) {
            optional = true;
            t = t.slice(0, -1).trim();
        }

        // count array nesting: trailing [] repeated
        let arrayDepth = 0;
        while (t.endsWith('[]')) {
            arrayDepth++;
            t = t.slice(0, -2).trim();
        }

        // parse integer flavors and optional ranges like uint8[0,255]
        const intMatch = t.match(/^(int|uint8|int8|uint16|int16|uint32|int32|uint8|int)\s*(?:\[\s*([^,\]]+)\s*,\s*([^\]]+)\s*\])?$/);
        let baseType;
        if (intMatch) {
            const name = intMatch[1];
            const rangeA = intMatch[2];
            const rangeB = intMatch[3];
            if (rangeA !== undefined && rangeB !== undefined) {
                const rmin = Number(rangeA);
                const rmax = Number(rangeB);
                if (!Number.isInteger(rmin) || !Number.isInteger(rmax)) throw new Error(`Schema parse error: invalid integer range for ${rawType} (struct ${structName})`);
                try { this.constructor.validateRangeAgainstIntrinsic(name, rmin, rmax); } catch (e) { throw new Error(e.message + ` (field type ${rawType} in struct ${structName})`); }
                baseType = { prim: 'int', name, range: [rmin, rmax] };
            } else {
                baseType = { prim: 'int', name, range: null };
            }
        } else {
            // primitive keywords or references: string, float, float32, float64, bool, any, or enum/struct name
            baseType = t; // keep as string; will be resolved in encode/decode/validation
        }

        // wrap arrays if any
        let typeDesc = baseType;
        for (let i = 0; i < arrayDepth; i++) {
            typeDesc = { prim: 'array', elem: typeDesc };
        }

        return { typeDesc, optional };
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

            let [decl, defVal] = part.split(":").map(s => s && s.trim());
            if (!decl) return;
            const tokens = decl.split(/\s+/).filter(Boolean);
            if (tokens.length < 2) return;
            const rawType = tokens[0];
            const name = tokens[1];

            // parse the type string into descriptor + optional flag
            const { typeDesc, optional } = this.parseTypeString(rawType, structName);

            fields.push({ type: typeDesc, name, default: defVal, optional, localEnums });
        });

        // compute a helper: list of optional field indices (for presence bitmap)
        const optionalIndices = [];
        for (let i = 0; i < fields.length; i++) {
            if (fields[i].optional) optionalIndices.push(i);
        }

        return { fields, localEnums, optionalIndices };
    }

    // ------------------------
    // Validation helpers (path-aware errors)
    // ------------------------
    validateValueForField(fieldType, value, path, localEnums) {
        // If type is an array descriptor
        if (typeof fieldType === 'object' && fieldType.prim === 'array') {
            if (!Array.isArray(value)) throw new Error(`Type violation at "${path}": Expected array, got ${typeof value} (${JSON.stringify(value)})`);
            for (let i = 0; i < value.length; i++) {
                this.validateValueForField(fieldType.elem, value[i], `${path}[${i}]`, localEnums);
            }
            return true;
        }

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

        // string-like tokens (primitive names or references)
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

        // object-shaped type (e.g., { prim: 'int', name, range } or {prim:'array', elem})
        if (typeof type === 'object') {
            if (type.prim === 'int') {
                if (!Number.isInteger(val)) return false;
                if (type.range) {
                    const [rmin, rmax] = type.range;
                    return val >= rmin && val <= rmax;
                }
                const bounds = this.constructor.intrinsicBoundsForInt(type.name);
                if (!bounds) return true;
                const [iMin, iMax] = bounds;
                return val >= iMin && val <= iMax;
            }
            if (type.prim === 'array') {
                if (!Array.isArray(val)) return false;
                for (let i = 0; i < val.length; i++) {
                    if (!this.validateAgainstType(val[i], type.elem, localEnums)) return false;
                }
                return true;
            }
        }

        // fallback: arrays and structs handled elsewhere in the newer API
        return true;
    }

    // ------------------------
    // Varint and fixed writers/readers (little-endian)
    // ------------------------
    encodeVarint(num) {
        const bytes = [];
        // allow numeric up to JS safe integer; use positive integers only here.
        let n = Number(num);
        while (n > 127) {
            bytes.push((n & 0x7f) | 0x80);
            n = Math.floor(n / 128);
        }
        bytes.push(n);
        return Uint8Array.from(bytes);
    }

    decodeVarint(buf, offset) {
        let num = 0, shift = 0, pos = offset;
        while (true) {
            if (pos >= buf.length) throw new Error("Buffer underflow while decoding varint");
            let b = buf[pos++];
            num |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7;
        }
        return [num, pos];
    }

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

    // ------------------------
    // Generic encode/decode helpers for arbitrary type descriptors
    // - encodeValueByType(typeDesc, value, path, localEnums) => Uint8Array (bytes)
    // - decodeValueByType(typeDesc, buf, pos, localEnums) => [value, newPos]
    // ------------------------
    encodeValueByType(typeDesc, value, path, localEnums) {
        const bytes = [];
        // arrays
        if (typeof typeDesc === 'object' && typeDesc.prim === 'array') {
            if (!Array.isArray(value)) throw new Error(`Type violation at "${path}": Expected array`);
            // length-prefixed
            bytes.push(...this.encodeVarint(value.length));
            for (let i = 0; i < value.length; i++) {
                const child = this.encodeValueByType(typeDesc.elem, value[i], `${path}[${i}]`, localEnums);
                bytes.push(...child);
            }
            return Uint8Array.from(bytes);
        }

        // integer object form
        if (typeof typeDesc === 'object' && typeDesc.prim === 'int') {
            // check range
            if (!Number.isInteger(value)) throw new Error(`Type violation at "${path}": Expected integer`);
            if (typeDesc.range) {
                const [rmin, rmax] = typeDesc.range;
                if (value < rmin || value > rmax) throw new Error(`Value for ${path} out of declared range ${rmin}..${rmax}`);
            }
            const info = MiniStruct.INT_TYPES[typeDesc.name] || MiniStruct.INT_TYPES['int'];
            if (info) return this.writeFixedInt(value, info.bits, info.signed);
            return this.encodeVarint(value);
        }

        // primitives by string or references
        if (typeof typeDesc === 'string') {
            if (typeDesc === 'string') {
                const enc = new TextEncoder().encode(value);
                return Uint8Array.from([...this.encodeVarint(enc.length), ...enc]);
            }
            if (typeDesc === 'any') {
                const s = JSON.stringify(value);
                const enc = new TextEncoder().encode(s);
                return Uint8Array.from([...this.encodeVarint(enc.length), ...enc]);
            }
            if (typeDesc === 'bool') {
                return Uint8Array.from([value ? 1 : 0]);
            }
            if (typeDesc === 'float' || typeDesc === 'float64') {
                return this.writeFloat64(value);
            }
            if (typeDesc === 'float32') {
                return this.writeFloat32(value);
            }
            // enum (local first)
            if (localEnums && localEnums[typeDesc]) {
                const e = localEnums[typeDesc];
                const num = typeof value === "string" ? e.nameToVal[value] : value;
                return Uint8Array.from(this.encodeVarint(num));
            }
            if (this.enums[typeDesc]) {
                const e = this.enums[typeDesc];
                const num = typeof value === "string" ? e.nameToVal[value] : value;
                return Uint8Array.from(this.encodeVarint(num));
            }
            // struct reference (recursive allowed)
            if (this.structs[typeDesc]) {
                const enc = this.encode(typeDesc, value);
                return Uint8Array.from([...this.encodeVarint(enc.length), ...enc]);
            }

            throw new Error(`Unknown type while encoding: ${typeDesc} at ${path}`);
        }

        throw new Error(`Unsupported type descriptor when encoding at ${path}`);
    }

    decodeValueByType(typeDesc, buf, pos, localEnums) {
        // arrays
        if (typeof typeDesc === 'object' && typeDesc.prim === 'array') {
            let [len, p2] = this.decodeVarint(buf, pos);
            pos = p2;
            const arr = [];
            for (let i = 0; i < len; i++) {
                const [v, np] = this.decodeValueByType(typeDesc.elem, buf, pos, localEnums);
                arr.push(v);
                pos = np;
            }
            return [arr, pos];
        }

        // integer object form
        if (typeof typeDesc === 'object' && typeDesc.prim === 'int') {
            const info = MiniStruct.INT_TYPES[typeDesc.name] || MiniStruct.INT_TYPES['int'];
            if (info) {
                const [v, np] = this.readFixedInt(buf, pos, info.bits, info.signed);
                return [v, np];
            }
            // fallback to varint
            const [v2, np2] = this.decodeVarint(buf, pos);
            return [v2, np2];
        }

        // primitives or references by string
        if (typeof typeDesc === 'string') {
            if (typeDesc === 'string') {
                let [len, p2] = this.decodeVarint(buf, pos);
                pos = p2;
                const s = new TextDecoder().decode(buf.slice(pos, pos + len));
                return [s, pos + len];
            }
            if (typeDesc === 'any') {
                let [len, p2] = this.decodeVarint(buf, pos);
                pos = p2;
                const s = new TextDecoder().decode(buf.slice(pos, pos + len));
                try { return [JSON.parse(s), pos + len]; } catch { return [s, pos + len]; }
            }
            if (typeDesc === 'bool') {
                return [!!buf[pos], pos + 1];
            }
            if (typeDesc === 'float' || typeDesc === 'float64') {
                return this.readFloat64(buf, pos);
            }
            if (typeDesc === 'float32') {
                return this.readFloat32(buf, pos);
            }
            // enums
            if (localEnums && localEnums[typeDesc]) {
                let [num, p2] = this.decodeVarint(buf, pos);
                pos = p2;
                const e = localEnums[typeDesc];
                return [e.valToName[num] ?? num, pos];
            }
            if (this.enums[typeDesc]) {
                let [num, p2] = this.decodeVarint(buf, pos);
                pos = p2;
                const e = this.enums[typeDesc];
                return [e.valToName[num] ?? num, pos];
            }
            // struct
            if (this.structs[typeDesc]) {
                let [len, p2] = this.decodeVarint(buf, pos);
                pos = p2;
                const subbuf = buf.slice(pos, pos + len);
                const obj = this.decode(typeDesc, subbuf, 0);
                return [obj, pos + len];
            }

            throw new Error(`Unknown type while decoding: ${typeDesc}`);
        }

        throw new Error(`Unsupported type descriptor while decoding`);
    }

    // ------------------------
    // Top-level encode/decode for named struct
    // - encode(typeName, obj) => Uint8Array
    // - decode(typeName, buf, offset=0) => object
    // ------------------------
    encode(typeName, obj) {
        const struct = this.structs[typeName];
        if (!struct) throw new Error("Unknown struct: " + typeName);

        // Field presence and encoding
        const bytes = [];

        // If the struct has optional fields, we will compose a presence bitmask and write it first.
        const optionalIndices = struct.optionalIndices || [];
        const hasOptionals = optionalIndices.length > 0;
        // We'll collect the body bytes (fields) then prefix presence varint if needed.
        const bodyBytes = [];

        for (let fi = 0; fi < struct.fields.length; fi++) {
            const field = struct.fields[fi];
            // presence detection: prefer own property over '?? default' so we can detect absent vs present-with-undefined
            const hasOwn = Object.prototype.hasOwnProperty.call(obj, field.name);
            let val = hasOwn ? obj[field.name] : (field.default !== undefined ? field.default : undefined);

            if (val === undefined) {
                if (field.optional) {
                    // absent optional -> don't encode its bytes (presence bit will be 0)
                    continue;
                } else {
                    // missing non-optional field that has no default is an error
                    throw new Error(`Missing required field ${typeName}.${field.name}`);
                }
            }

            // validate value (path-aware)
            this.validateValueForField(field.type, val, `${typeName}.${field.name}`, field.localEnums ?? struct.localEnums);

            // encode field value according to its type (returned Uint8Array)
            const enc = this.encodeValueByType(field.type, val, `${typeName}.${field.name}`, field.localEnums ?? struct.localEnums);
            bodyBytes.push(...enc);
        }

        // build and prefix presence bitmask if the struct had optionals
        if (hasOptionals) {
            let mask = 0;
            // optionalIndices is an array of field indices that are optional, mapped to bit positions 0..n-1
            for (let bitPos = 0; bitPos < optionalIndices.length; bitPos++) {
                const fieldIndex = optionalIndices[bitPos];
                const field = struct.fields[fieldIndex];
                const hasOwn = Object.prototype.hasOwnProperty.call(obj, field.name);
                const val = hasOwn ? obj[field.name] : (field.default !== undefined ? field.default : undefined);
                if (val !== undefined) {
                    // present -> set bit
                    mask += (1 << bitPos); // safe for reasonably sized optional counts
                }
            }
            bytes.push(...this.encodeVarint(mask));
        }

        // append body
        bytes.push(...bodyBytes);
        return Uint8Array.from(bytes);
    }

    decode(typeName, buf, offset = 0) {
        const struct = this.structs[typeName];
        if (!struct) throw new Error("Unknown struct: " + typeName);
        const obj = {};
        let pos = offset;

        // read presence mask if necessary
        const optionalIndices = struct.optionalIndices || [];
        const hasOptionals = optionalIndices.length > 0;
        let presenceMask = 0;
        if (hasOptionals) {
            let pm;
            [pm, pos] = this.decodeVarint(buf, pos);
            presenceMask = pm;
        }

        // iterate fields in declared order
        // for optional fields, consult presenceMask to know if value present
        // for required fields, always attempt to decode (but if buffer ends, break)
        let optionalBitCounter = 0;
        for (let fi = 0; fi < struct.fields.length; fi++) {
            const field = struct.fields[fi];

            // if buffer ended, stop
            if (pos >= buf.length) {
                // remaining fields remain undefined (if optional) else omitted
                break;
            }

            if (field.optional) {
                const bitPos = optionalBitCounter++;
                const present = ((presenceMask >> bitPos) & 1) === 1;
                if (!present) {
                    // absent optional field -> leave undefined / skip decoding
                    continue;
                }
                // else decode as usual
            }

            // decode value by type
            const [val, newPos] = this.decodeValueByType(field.type, buf, pos, field.localEnums ?? struct.localEnums);
            obj[field.name] = val;
            pos = newPos;
        }

        return obj;
    }
}

// ------------------------
// Demo schema showing recursive struct, optionals, and arrays
// ------------------------
let schema = `
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

// Recursive Node example: a Node can optionally point to another Node, and have a typed array of children Nodes.
struct Node {
  int value;
  Node? next;        // optional recursive link
  Node[] children;   // array of Nodes (can be nested deeper)
}

struct User {
  // inline enum for role
  enum Role { ADMIN = 1; USER = 2; GUEST = 3; }

  string name;
  uint8 id;
  float64 score;
  bool active;
  Address address;
  Role role;
  Color favoriteColor;
  any metadata; // arbitrary JSON blob
  string bio; // unicode-friendly text
  string[] tags; // array of strings
  Node? rootNode; // optional recursive root
}
`;

const ms = new MiniStruct(schema);

// demo object with recursion and arrays
const demoNode = { value: 1, next: { value: 2, next: undefined, children: [] }, children: [{ value: 10, children: [] }] };
const demo = {
    name: "Joséphine ✨",
    id: 42,
    score: 98.6,
    active: true,
    address: { street: "123 Café Blvd", city: "Zürich", zip: 8001 },
    role: "ADMIN",
    favoriteColor: "BLUE",
    metadata: { tags: ["demo", "测试"], prefs: { theme: "dark" } },
    bio: "Loves ☕️, music, and bytes.",
    tags: ["alpha", "β"],
    rootNode: demoNode
};

function bytesToBase64_compat(u8) {
    if (typeof btoa === 'function') {
        let s = "";
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s);
    }
    return Buffer.from(u8).toString('base64');
}
function base64ToBytes_compat(b64) {
    if (typeof atob === 'function') {
        const s = atob(b64);
        const arr = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
        return arr;
    }
    return Uint8Array.from(Buffer.from(b64, 'base64'));
}

try {
    const encoded = ms.encode("User", demo);
    console.log("Encoded (base64):", bytesToBase64_compat(encoded));
    const decoded = ms.decode("User", encoded);
    console.log("Decoded object:", decoded);
} catch (e) {
    console.error("Demo Error:", e && e.message ? e.message : e);
}
