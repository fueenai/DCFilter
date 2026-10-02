const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/safety-policy.js');

// Synthetic normalized vectors exercise the decision boundary without harmful photos.
const vector = similarity => [similarity, Math.sqrt(1 - similarity * similarity)];
const prompts = (safe, blocked, sexual) => [
  { category: 'safe', embedding: vector(safe) },
  { category: 'blocked', embedding: vector(blocked) },
  ...(sexual === undefined ? [] : [{ category: 'sexual', embedding: vector(sexual) }])
];
const classify = (safe, blocked, options, sexual) => policy.classifyEmbedding([1, 0], prompts(safe, blocked, sexual), options);

test('clear safe, blocked and uncertain synthetic similarities remain distinct', () => {
  assert.equal(classify(0.4, 0.2).status, 'safe');
  assert.equal(classify(0.2, 0.4).status, 'blocked');
  assert.equal(classify(0.30, 0.27).status, 'uncertain');
  assert.equal(classify(0.1, 0.05).status, 'uncertain');
  assert.equal(classify(0.4, 0.2).score < classify(0.2, 0.4).score, true);
});

test('strict mode requires both the safe score floor and a clear margin', () => {
  assert.equal(classify(0.23, 0.17).status, 'safe');
  assert.equal(classify(0.23 - 1e-8, 0.17).status, 'uncertain');
  assert.equal(classify(0.3, 0.245 + 1e-8).status, 'uncertain');
  assert.equal(classify(0.3, 0.245 - 1e-8).status, 'safe');
});

test('balanced mode changes only the deliberate safe acceptance boundary', () => {
  assert.equal(classify(0.31, 0.27).status, 'uncertain');
  assert.equal(classify(0.31, 0.27, { sensitivity: 'balanced' }).status, 'safe');
  assert.equal(classify(0.2, 0.15, { sensitivity: 'balanced' }).status, 'safe');
  assert.equal(classify(0.2 - 1e-8, 0.15, { sensitivity: 'balanced' }).status, 'uncertain');
  for (const sensitivity of ['strict', 'balanced', 'unknown']) {
    assert.equal(classify(0.2, 0.4, { sensitivity }).status, 'blocked');
  }
});

test('close evidence remains covered and only a clear unsafe lead is labeled blocked', () => {
  assert.equal(classify(0.31, 0.30).status, 'uncertain');
  assert.equal(classify(0.19, 0.20).status, 'uncertain');
  assert.equal(classify(0.18, 0.20).status, 'blocked');
  assert.equal(classify(0.18, 0.20 - 1e-8).status, 'uncertain');
});

test('sexual screening is on by default and disabling it retains gore screening', () => {
  assert.equal(classify(0.4, 0.1, undefined, 0.6).status, 'blocked');
  assert.equal(classify(0.4, 0.1, { sexual: false }, 0.6).status, 'safe');
  assert.equal(classify(0.2, 0.5, { sexual: false }, 0.6).status, 'blocked');
  assert.deepEqual(policy.normalizeOptions({ sexual: 0, sensitivity: 'invalid' }), { sexual: true, sensitivity: 'strict' });
});

test('invalid or incomplete model output cannot produce a safe verdict', () => {
  for (const embedding of [[], [0, 0], [NaN, 1], [Infinity, 1], ['1', '0'], [true, false]]) {
    assert.throws(() => policy.classifyEmbedding(embedding, prompts(0.4, 0.2)));
  }
  assert.throws(() => policy.classifyEmbedding([1, 0], []));
  assert.throws(() => policy.classifyEmbedding([1, 0], [{ category: 'safe', embedding: vector(0.4) }]));
  assert.throws(() => policy.classifyEmbedding([1, 0], [{ category: 'safe', embedding: [1] }]));
  assert.throws(() => policy.classifyEmbedding([1, 0], [{ category: 'safe', embedding: [NaN, 0] }]));
});

test('image downloads accept only credential-free DCInside HTTPS URLs', () => {
  for (const host of ['dcinside.com', 'dcimg8.dcinside.com', 'dcimg1.dcinside.co.kr']) {
    assert.equal(policy.validateImageUrl(`https://${host}/viewimage.php?id=1#fragment`).hash, '');
  }
  for (const url of ['http://dcinside.com/a', 'data:image/png,abc', 'blob:https://dcinside.com/abc',
    'https://dcinside.com.evil.example/a', 'https://evildcinside.com/a', 'https://dcinside.co.kr.evil.example/a',
    'https://user:password@dcinside.com/a', 'https://dcinside.com:444/a', 'https://127.0.0.1/a', '', null]) {
    assert.throws(() => policy.validateImageUrl(url), String(url));
  }
  assert.throws(() => policy.validateImageUrl('https://dcinside.com/' + 'a'.repeat(8192)));
});

test('resolution and aspect limits reject oversized and long images', () => {
  policy.checkDimensions(100, 400);
  policy.checkDimensions(4096, 4096);
  for (const dimensions of [[0, 10], [1.5, 10], [NaN, 10], [10001, 10000], [6000, 6000], [100, 401]]) {
    assert.throws(() => policy.checkDimensions(...dimensions));
  }
});

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4); data.copy(chunk, 8);
  return chunk;
};
const png = (extra = [], width = 2, height = 2) => {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), ...extra, pngChunk('IEND')]);
};
const webpChunk = (type, data) => {
  const chunk = Buffer.alloc(8 + data.length + data.length % 2);
  chunk.write(type); chunk.writeUInt32LE(data.length, 4); data.copy(chunk, 8); return chunk;
};
const webp = (...chunks) => {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};
const webpStillChunk = () => webpChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0]));

test('format sniffing accepts supported still-image headers', () => {
  // These fixtures test structural sniffing; the worker separately requires successful image decoding.
  assert.deepEqual(policy.inspectImageBytes(png()), { type: 'image/png', width: 2, height: 2 });
  assert.deepEqual(policy.inspectImageBytes(webp(webpStillChunk())), { type: 'image/webp', width: 1, height: 1 });
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 2, 0, 3, 0, 255, 217]);
  assert.deepEqual(policy.inspectImageBytes(jpeg), { type: 'image/jpeg', width: 3, height: 2 });
});

test('GIF and animation chunks are rejected even when a URL would hide the real format', () => {
  assert.throws(() => policy.inspectImageBytes(Buffer.from('GIF89a')));
  for (const type of ['acTL', 'fcTL', 'fdAT']) {
    assert.throws(() => policy.inspectImageBytes(png([pngChunk('tEXt', Buffer.alloc(120)), pngChunk(type)])));
  }
  for (const type of ['ANIM', 'ANMF']) {
    assert.throws(() => policy.inspectImageBytes(webp(webpStillChunk(), webpChunk(type, Buffer.alloc(8)))));
  }
  const animatedHeader = Buffer.alloc(10); animatedHeader[0] = 2;
  assert.throws(() => policy.inspectImageBytes(webp(webpChunk('VP8X', animatedHeader), webpStillChunk())));
});

test('malformed, truncated and unsupported image bytes are rejected', () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(policy.MAX_IMAGE_BYTES + 1), Buffer.from('<svg></svg>'),
    Buffer.from('not an image'), png().subarray(0, -1), webp(webpStillChunk()).subarray(0, -1), Buffer.from([255, 216, 255, 192])]) {
    assert.throws(() => policy.inspectImageBytes(bytes));
  }
  const malformed = png(); malformed.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => policy.inspectImageBytes(malformed));
  assert.throws(() => policy.inspectImageBytes(png([], 100, 401)));
});
