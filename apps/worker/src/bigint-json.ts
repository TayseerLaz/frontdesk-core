// Make JSON.stringify tolerate BigInt. Cart money columns are BigInt; this is a
// runtime backstop for any worker serialization path (webhook delivery payloads,
// logs) that might touch a bigint money value. Our values are < 2^53, so
// Number() is lossless. Imported for its side effect.
if (typeof (BigInt.prototype as unknown as { toJSON?: unknown }).toJSON !== 'function') {
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
    return Number(this);
  };
}

export {};
