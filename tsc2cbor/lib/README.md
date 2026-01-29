# Library Structure

Organized library modules for TSC2CBOR encoder/decoder.

## 📁 Folder Organization

```
lib/
├── common/          # Shared modules (encoder + decoder)
├── encoder/         # YAML/JSON → CBOR encoding
└── decoder/         # CBOR → YAML/JSON decoding
```

---

## 📦 Common Modules (`lib/common/`)

Shared utilities used by both encoder and decoder.

### `cbor-encoder.js`
**Purpose**: Low-level CBOR binary encoding/decoding

**Key Functions**:
- `encodeToCbor(obj)` - Encode JavaScript object to CBOR binary
- `decodeFromCbor(buffer)` - Decode CBOR binary to JavaScript object
- `getEncodingStats(cbor, json)` - Calculate compression statistics
- `getCborDiagnostic(buffer)` - Convert CBOR to diagnostic notation
- `verifyRoundTrip(original, cbor)` - Verify encode → decode integrity

**Dependencies**: `cbor-x`

---

### `sid-resolver.js`
**Purpose**: YANG path ↔ SID mapping resolution

**Key Functions**:
- `buildSidInfo(sidFile)` - Parse .sid file into BiMap structure
- `resolvePathToSid(localName, sidInfo, currentPath)` - Find SID for YANG path
- `resolveIdentityToSid(identityName, sidInfo)` - Find SID for identity
- `augmentSidInfoWithAliases(sidInfo, choiceNames, caseNames)` - Add choice/case aliases

**Data Structures**:
- **Temporary**: `pathEntries` (path → {sid, prefixedPath}) - deleted after pathToInfo built
- **Final Maps**: `prefixedPathToSid`, `identityToSid` ↔ `sidToIdentity`, `pathToInfo`, `sidToInfo`, `leafToPaths`
- **Node Info**: Parent relationships, Delta-SID, depth tracking

**Dependencies**: Built-in modules only

---

### `yang-type-extractor.js`
**Purpose**: Extract type information from YANG files

**Pipeline**: YANG → pyang → YIN (XML) → xml2js → Type Table

**Key Functions**:
- `extractYangTypes(yangFile, searchPath)` - Extract all type info
- `getTypeForPath(yangPath, typeTable)` - Get type for specific path

**Type Table Structure**:
```javascript
{
  types: Map<path, typeInfo>,        // Leaf type definitions
  identities: Map<name, info>,       // Identity definitions
  typedefs: Map<name, typeInfo>,     // Named typedefs
  choiceNames: Set<string>,          // Choice node names
  caseNames: Set<string>,            // Case node names
  nodeOrders: Map<name, order>       // YANG node order (VelocityDriveSP)
}
```

**TypeInfo Format**:
```javascript
{
  type: 'enumeration',           // Base type
  original: 'instance-type',     // Original typedef name
  enum: {                        // BiMap for O(1) lookup
    nameToValue: Map<string, number>,
    valueToName: Map<number, string>
  },
  fractionDigits: 2,            // For decimal64
  base: 'identity-name',        // For identityref
  bits: {bitName: position},    // For bits type
  unionTypes: [typeInfo...]     // For union type
}
```

**Dependencies**: `xml2js`, `child_process` (pyang)

---

## 🔼 Encoder Modules (`lib/encoder/`)

Converts YAML/JSON configuration to CBOR with Delta-SID encoding.

### `transformer-delta.js`
**Purpose**: Main transformation engine - JSON → Delta-SID object

**Key Functions**:
- `transform(jsonObj, typeTable, sidInfo, options)` - Main entry point
- `transformTree(...)` - Recursive transformation with parent tracking
- `getTransformStats(deltaSidObj, jsonObj)` - Transformation statistics

**Features**:
- **Parent-aware Delta-SID**: Child SID = delta from parent SID
- **VelocityDriveSP sorting**: YANG order + Absolute SID fallback
- **RFC 8949 sorting**: Canonical byte-lexicographic order
- **Array handling**: List keys with proper indexing
- **Vendor typedef support**: Automatic merging in tsc2cbor.js

**Dependencies**: `value-encoder.js`, `../common/sid-resolver.js`

---

### `value-encoder.js`
**Purpose**: Encode YANG-typed values to CBOR format

**Key Functions**:
- `encodeValue(value, typeInfo, sidInfo, isUnion)` - Encode by type
- `encodeEnum(value, typeInfo)` - String → enum value
- `encodeIdentity(value, sidInfo)` - Identity → SID
- `encodeDecimal64(value, fractionDigits)` - Number → Tag(4, [exp, mantissa])
- `encodeBits(bitArray, typeInfo)` - Bit names → Tag(43, Buffer)
- `encodeBinary(base64String)` - Base64 → Buffer
- `encodeUnion(value, typeInfo, sidInfo)` - Try each union member type

**RFC 9254 Tags**:
- **Tag(4)**: Decimal64 as `[exponent, mantissa]`
- **Tag(43)**: Bits as byte array
- **Tag(44)**: Enum in union context
- **Tag(45)**: Identity in union context

**Dependencies**: `cbor-x` (Tag), `../common/sid-resolver.js`

---

### `delta-sid-encoder.js`
**Purpose**: Delta-SID statistics and utilities

**Key Functions**:
- `getDeltaSidStats(deltaSidObj)` - Calculate Delta-SID compression stats

**Note**: Sequential delta encoding is handled directly by `transformer-delta.js` using parent-child relationships, not this file.

**Dependencies**: None

---

## 🔽 Decoder Modules (`lib/decoder/`)

Converts CBOR with Delta-SID back to YAML/JSON.

### `detransformer-delta.js`
**Purpose**: Main decoding engine - CBOR Delta-SID → Nested JSON

**Key Functions**:
- `detransform(cborData, typeTable, sidInfo)` - Main entry (returns nested)
- `detransformFromDeltaSid(cborData, typeTable, sidInfo)` - Legacy (returns flat)
- `cborToJsonDelta(...)` - Recursive Delta-SID resolution
- `buildSidInfoMap(sidInfo)` - Create reverse lookup map
- `getDetransformStats(deltaSidObj, nested)` - Decoding statistics

**Delta-SID Resolution**:
```javascript
// For numeric keys:
1. Try Delta-SID: absoluteSid = key + parentSid
2. Verify it's a valid child of parent
3. Fallback to Absolute-SID if delta fails
4. Use localName as decoded key
```

**Dependencies**: `value-decoder.js`

---

### `value-decoder.js`
**Purpose**: Decode CBOR values back to YANG types

**Key Functions**:
- `decodeValue(cborValue, typeInfo, sidInfo, isUnion, typeTable, yangPath)` - Decode by type
- `decodeEnum(cborValue, typeInfo, isUnion, yangPath)` - Enum value → string name
- `decodeIdentity(cborValue, typeInfo, sidInfo, isUnion)` - SID → identity name
- `decodeDecimal64(cborValue)` - Tag(4) → JavaScript number
- `decodeBits(cborValue, typeInfo)` - Tag(43) → bit name array
- `decodeBinary(cborValue)` - Buffer → base64 string
- `decodeUnion(cborValue, typeInfo, sidInfo, typeTable, yangPath)` - Try union members

**BiMap Reverse Lookup**:
- Enum: `typeInfo.enum.valueToName.get(value)` → name
- Identity: `sidInfo.sidToIdentity.get(sid)` → identity

**Dependencies**: `cbor-x` (Tag)

---

## 📊 Dependency Graph

```
┌─────────────────────────────────────────────────┐
│                 tsc2cbor.js                     │
│                  (Encoder)                       │
└───────────────────┬─────────────────────────────┘
                    │
        ┌───────────┼──────────┬─────────────┐
        ▼           ▼          ▼             ▼
    ┌────────┐ ┌─────────┐ ┌──────┐  ┌────────────┐
    │ common/│ │encoder/ │ │stats │  │Vendor merge│
    │        │ │         │ │      │  │ (in main)  │
    └────┬───┘ └────┬────┘ └──────┘  └────────────┘
         │          │
         │    ┌─────┴──────────┐
         │    ▼                ▼
         │ transformer-  value-encoder
         │   delta          │
         │    │             │
         └────┴─────────────┴───────────┐
              ▼                         ▼
        sid-resolver        yang-type-extractor
              │                         │
              └────────┬────────────────┘
                       ▼
                 cbor-encoder


┌─────────────────────────────────────────────────┐
│                 cbor2tsc.js                     │
│                  (Decoder)                       │
└───────────────────┬─────────────────────────────┘
                    │
        ┌───────────┼──────────┬─────────────┐
        ▼           ▼          ▼             ▼
    ┌────────┐ ┌─────────┐ ┌──────┐  ┌────────────┐
    │ common/│ │decoder/ │ │stats │  │Vendor merge│
    │        │ │         │ │      │  │ (in main)  │
    └────┬───┘ └────┬────┘ └──────┘  └────────────┘
         │          │
         │    ┌─────┴──────────┐
         │    ▼                ▼
         │detransformer- value-decoder
         │   delta
         │
         └────────┬────────────────────┐
                  ▼                    ▼
            sid-resolver    yang-type-extractor
                  │                    │
                  └────────┬───────────┘
                           ▼
                     cbor-encoder
```

---

## 🗑️ Removed Files (Unused)

The following files were removed during restructuring as they are not used in the current pipeline:

- ❌ `transformer.js` - Legacy transformer (replaced by transformer-delta.js)
- ❌ `detransformer.js` - Legacy detransformer (replaced by detransformer-delta.js)
- ❌ `delta-encoder.js` - Sequential delta encoder (superseded by parent-aware Delta-SID)
- ❌ `yaml-loader.js` - Unused YAML loader
- ❌ `yaml-parser.js` - Unused YAML parser
- ❌ `yang-parser.js` - Unused YANG parser

---

## 🔧 Import Path Changes

After restructuring, imports changed from flat to hierarchical:

**Before**:
```javascript
import { transform } from './lib/transformer-delta.js';
import { buildSidInfo } from './lib/sid-resolver.js';
```

**After**:
```javascript
import { transform } from './lib/encoder/transformer-delta.js';
import { buildSidInfo } from './lib/common/sid-resolver.js';
```

**Within lib modules**:
```javascript
// encoder/transformer-delta.js
import { encodeValue } from './value-encoder.js';           // Same folder
import { resolvePathToSid } from '../common/sid-resolver.js';  // Parent folder
```

---

## ✅ Testing

All encoder/decoder functionality has been tested after restructuring:

```bash
# Encoder test
node tsc2cbor.js -i test/test-data/CT.yaml -c .yang-cache/... -o /tmp/test.cbor
# ✅ Success

# Decoder test
node cbor2tsc.js -i /tmp/test.cbor -c .yang-cache/... -o /tmp/decoded.yaml
# ✅ Success

# Roundtrip verification
grep "instance-type:" /tmp/decoded.yaml
# instance-type: relay ✅
```

---

## 📝 Summary

| Category | Count | Files |
|----------|-------|-------|
| **Common** | 3 | cbor-encoder, sid-resolver, yang-type-extractor |
| **Encoder** | 3 | transformer-delta, value-encoder, delta-sid-encoder |
| **Decoder** | 2 | detransformer-delta, value-decoder |
| **Removed** | 6 | Legacy unused files |
| **Total Active** | **8** | Clean, organized structure |

The library is now well-organized, maintainable, and tested! 🎉
