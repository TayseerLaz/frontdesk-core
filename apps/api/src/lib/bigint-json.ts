// Make JSON.stringify tolerate BigInt. Cart money columns are BigInt (so high-
// denomination currencies like LBP can't overflow 32-bit Int on large carts).
// Our money values are always well under 2^53, so Number() is lossless. This is
// a runtime backstop for any UNTYPED serialization path — webhook payloads,
// Redis cache writes, pino logs — that bypasses the Number()-casting response
// serializers. Typed API responses already down-cast to number explicitly.
//
// Importing this module for its side effect installs the shim process-wide.
if (typeof (BigInt.prototype as unknown as { toJSON?: unknown }).toJSON !== 'function') {
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
    return Number(this);
  };
}

export {};
