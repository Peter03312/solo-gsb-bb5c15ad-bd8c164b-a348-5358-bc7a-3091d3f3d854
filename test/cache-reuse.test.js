import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { planCacheReuse, MAX_CACHED_INTERVALS, MAX_EDITS } from '../src/cache-reuse.js';

const app = buildApp();
const url = '/cache-reuse-plan';

function reusePlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('no edits: cache is merged and maps identity, gaps are its complement', async () => {
  const res = await reusePlan({
    size: 20,
    cached: [
      { start: 0, end: 4 },
      { start: 5, end: 9 }, // adjacent -> merged
      { start: 15, end: 19 },
    ],
    edits: [],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.oldSize, 20);
  assert.equal(body.newSize, 20);
  assert.equal(body.deletedBytes, 0);
  assert.equal(body.insertedBytes, 0);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 15, oldEnd: 19, newStart: 15, newEnd: 19 },
  ]);
  assert.equal(body.reusableBytes, 15);
  assert.deepEqual(body.gaps, [{ start: 10, end: 14 }]);
  assert.equal(body.gapBytes, 5);
});

test('pure insertion shifts later bytes and splits the mapping (old-adjacent only)', async () => {
  // Insert 3 bytes at old offset 5; cache [0,9] splits: [0,4] stays, [5,9]
  // moves to [8,12]; the inserted [5,7] is a gap, so the two mappings do not
  // merge even though their old intervals are adjacent.
  const res = await reusePlan({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [{ start: 5, deleteBytes: 0, insertBytes: 3 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 13);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 5, oldEnd: 9, newStart: 8, newEnd: 12 },
  ]);
  assert.deepEqual(body.gaps, [{ start: 5, end: 7 }]);
  assert.equal(body.gapBytes, 3);
});

test('pure deletion: deleted cache bytes vanish, new-adjacent mappings stay split', async () => {
  // Delete old [4,5] (2 bytes). Cached [0,3] maps [0,3]; cached [6,9] maps
  // [4,7]. They are adjacent in the NEW resource but not in the old one, so
  // they remain two mappings with the deletion gap implied in between.
  const res = await reusePlan({
    size: 10,
    cached: [
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ],
    edits: [{ start: 4, deleteBytes: 2, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 8);
  assert.equal(body.deletedBytes, 2);
  assert.equal(body.insertedBytes, 0);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 3, newStart: 0, newEnd: 3 },
    { oldStart: 6, oldEnd: 9, newStart: 4, newEnd: 7 },
  ]);
  assert.deepEqual(body.gaps, []);
  assert.equal(body.reusableBytes, 8);
  assert.equal(body.gapBytes, 0);
});

test('equal-length replacement keeps size; deleted bytes are gaps, survivors unshifted', async () => {
  const res = await reusePlan({
    size: 12,
    cached: [
      { start: 0, end: 2 },
      { start: 3, end: 7 },
      { start: 8, end: 11 },
    ],
    edits: [{ start: 4, deleteBytes: 3, insertBytes: 3 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 12);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 3, newStart: 0, newEnd: 3 },
    { oldStart: 7, oldEnd: 11, newStart: 7, newEnd: 11 },
  ]);
  assert.deepEqual(body.gaps, [{ start: 4, end: 6 }]);
  assert.equal(body.reusableBytes, 9);
  assert.equal(body.gapBytes, 3);
});

test('replacement that grows: deletion gap plus insertion gap merge into one new gap', async () => {
  // Delete old [4,5], insert 4 bytes there: inserted new [4,7]; cached [6,9]
  // moves to [8,11]. Uncached old neighbors join the gap merge.
  const res = await reusePlan({
    size: 10,
    cached: [
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ],
    edits: [{ start: 4, deleteBytes: 2, insertBytes: 4 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 12);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 3, newStart: 0, newEnd: 3 },
    { oldStart: 6, oldEnd: 9, newStart: 8, newEnd: 11 },
  ]);
  assert.deepEqual(body.gaps, [{ start: 4, end: 7 }]);
  assert.equal(body.gapBytes, 4);
});

test('deletion straddling cache intervals: intervals inside the deletion vanish', async () => {
  // Delete old [3,7]; cache [0,3], [6,8], [10,12] within a 15-byte resource.
  // First interval contributes [0,2]; the whole middle interval falls in the
  // deletion; last interval maps [10,12] -> [5,7].
  const res = await reusePlan({
    size: 15,
    cached: [
      { start: 0, end: 3 },
      { start: 6, end: 8 },
      { start: 10, end: 12 },
    ],
    edits: [{ start: 3, deleteBytes: 5, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 10);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 },
    { oldStart: 8, oldEnd: 8, newStart: 3, newEnd: 3 },
    { oldStart: 10, oldEnd: 12, newStart: 5, newEnd: 7 },
  ]);
  // Deleting [3,7]: first interval contributes old [0,2]; old 8 survives ->
  // new 3; last interval old [10,12] -> new [5,7]. New 3 is reused (old 8),
  // so the first gap is only the uncached survivor old 9 at new 4.
  assert.deepEqual(body.gaps, [
    { start: 4, end: 4 },
    { start: 8, end: 9 },
  ]);
});

test('a large deletion covering several cache intervals', async () => {
  const res = await reusePlan({
    size: 30,
    cached: [
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 10, end: 12 },
      { start: 25, end: 29 },
    ],
    edits: [{ start: 4, deleteBytes: 20, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 11);
  // old [5,7] and [10,12] are wholly inside the deleted [4,23] and vanish.
  // Survivors old [25,29] (-> new [6,10]); old 24 itself was never cached, so
  // it does not extend the second mapping down to new 4.
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 },
    { oldStart: 25, oldEnd: 29, newStart: 6, newEnd: 10 },
  ]);
  // New [3] = uncached old 3, new [4] = inserted byte, new [5] = uncached
  // old 24: consecutive and merged ascending into one gap.
  assert.deepEqual(body.gaps, [{ start: 3, end: 5 }]);
});

test('multiple edits accumulate shifts; edits and intervals may be unordered', async () => {
  const ordered = {
    size: 40,
    cached: [
      { start: 35, end: 39 },
      { start: 0, end: 9 },
      { start: 10, end: 14 }, // adjacent to [0,9] -> merged first
    ],
    edits: [
      { start: 30, deleteBytes: 2, insertBytes: 0 },
      { start: 20, deleteBytes: 0, insertBytes: 5 },
      { start: 5, deleteBytes: 5, insertBytes: 2 },
    ],
  };
  const res1 = await reusePlan(ordered);
  const res2 = await reusePlan({
    ...ordered,
    cached: [...ordered.cached].reverse(),
    edits: [...ordered.edits].reverse(),
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(res1.json(), res2.json());

  const body = res1.json();
  // Edits sorted: @5 deletes 5 inserts 2 (net -3), @20 inserts 5 (net +5),
  // @30 deletes 2 (net -2): net 0, so newSize stays 40.
  assert.equal(body.newSize, 40);
  assert.equal(body.deletedBytes, 7);
  assert.equal(body.insertedBytes, 7);
  // Cache merges to [0,14] and [35,39].
  // [0,4] is untouched by edit @5 -> new [0,4]; [10,14] sees the -3 shift ->
  // new [7,11]. [35,39] sees all three edits, net shift 0 -> new [35,39].
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 4, newStart: 0, newEnd: 4 },
    { oldStart: 10, oldEnd: 14, newStart: 7, newEnd: 11 },
    { oldStart: 35, oldEnd: 39, newStart: 35, newEnd: 39 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 5, end: 6 }, // inserted at edit @5
    { start: 12, end: 34 }, // uncached tail of the first cache region, insertion @20 and deletion @30 all merge
  ]);
  assert.equal(body.reusableBytes, 15);
  assert.equal(body.gapBytes, 25);
});

test('tail insertion at start === size is allowed', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [{ start: 8, end: 9 }],
    edits: [{ start: 10, deleteBytes: 0, insertBytes: 4 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 14);
  // The edit starts after every old byte, so cached [8,9] keeps its offsets;
  // the four appended bytes form the gap [10,13].
  assert.deepEqual(body.mappings, [{ oldStart: 8, oldEnd: 9, newStart: 8, newEnd: 9 }]);
  assert.deepEqual(body.gaps, [
    { start: 0, end: 7 },
    { start: 10, end: 13 },
  ]);
});

test('insertion before position 0 semantics: insertion at 0 shifts everything', async () => {
  const res = await reusePlan({
    size: 4,
    cached: [{ start: 0, end: 3 }],
    edits: [{ start: 0, deleteBytes: 0, insertBytes: 2 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 6);
  assert.deepEqual(body.mappings, [{ oldStart: 0, oldEnd: 3, newStart: 2, newEnd: 5 }]);
  assert.deepEqual(body.gaps, [{ start: 0, end: 1 }]);
});

test('empty resource with empty cache and empty edits is a valid plan', async () => {
  const res = await reusePlan({ size: 0, cached: [], edits: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    oldSize: 0,
    newSize: 0,
    deletedBytes: 0,
    insertedBytes: 0,
    mappings: [],
    reusableBytes: 0,
    gaps: [],
    gapBytes: 0,
  });
});

test('empty resource accepts a tail insertion and reports it as the only gap', async () => {
  const res = await reusePlan({
    size: 0,
    cached: [],
    edits: [{ start: 0, deleteBytes: 0, insertBytes: 5 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 5);
  assert.deepEqual(body.gaps, [{ start: 0, end: 4 }]);
  assert.deepEqual(body.mappings, []);
});

test('size 0 with non-empty cache is rejected (no interval fits an empty resource)', async () => {
  const res = await reusePlan({
    size: 0,
    cached: [{ start: 0, end: 0 }],
    edits: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('duplicate edit starts are rejected', async () => {
  const res = await reusePlan({
    size: 20,
    cached: [],
    edits: [
      { start: 5, deleteBytes: 1, insertBytes: 0 },
      { start: 5, deleteBytes: 0, insertBytes: 1 },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_EDIT_START');
});

test('an edit starting inside a previous deletion range is rejected', async () => {
  const res = await reusePlan({
    size: 50,
    cached: [],
    edits: [
      { start: 10, deleteBytes: 10, insertBytes: 0 },
      { start: 19, deleteBytes: 1, insertBytes: 0 },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDIT_INSIDE_DELETION');
});

test('an edit starting exactly where the previous deletion ends is allowed', async () => {
  const res = await reusePlan({
    size: 50,
    cached: [{ start: 0, end: 49 }],
    edits: [
      { start: 10, deleteBytes: 10, insertBytes: 2 },
      { start: 20, deleteBytes: 0, insertBytes: 3 },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // net change: -8 +3 = -5 => newSize 45
  assert.equal(body.newSize, 45);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 20, oldEnd: 49, newStart: 15, newEnd: 44 },
  ]);
  assert.deepEqual(body.gaps, [{ start: 10, end: 14 }]);
});

test('double-zero edits are rejected', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [],
    edits: [{ start: 3, deleteBytes: 0, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EMPTY_EDIT');
});

test('deletion past the resource end is rejected', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [],
    edits: [{ start: 8, deleteBytes: 3, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDIT_OUT_OF_BOUNDS');
});

test('edit start past the resource end is rejected', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [],
    edits: [{ start: 11, deleteBytes: 0, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDIT_OUT_OF_BOUNDS');
});

test('invalid closed intervals are rejected', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [{ start: 6, end: 5 }],
    edits: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CACHED_RANGE');
});

test('cache intervals past the resource end are rejected', async () => {
  const res = await reusePlan({
    size: 10,
    cached: [{ start: 5, end: 10 }],
    edits: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('new size overflowing MAX_SAFE_INTEGER is rejected', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  const res = await reusePlan({
    size: max,
    cached: [],
    edits: [{ start: max, deleteBytes: 0, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'NEW_SIZE_OVERFLOW');
});

test('overflow accumulates across multiple edits', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  const res = await reusePlan({
    size: max - 5,
    cached: [],
    edits: [
      { start: 0, deleteBytes: 1, insertBytes: 3 }, // +2
      { start: max - 5, deleteBytes: 0, insertBytes: 4 }, // +4 -> +6 overflows
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'NEW_SIZE_OVERFLOW');
});

test('deletions can bring an overflowing growth back under the cap', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  const res = await reusePlan({
    size: max,
    cached: [{ start: 0, end: 0 }],
    edits: [
      { start: 0, deleteBytes: 1, insertBytes: 0 },
      { start: max, deleteBytes: 0, insertBytes: 1 },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, max);
});

test('arrays over 1000 entries are rejected', async () => {
  const tooManyCached = Array.from({ length: MAX_CACHED_INTERVALS + 1 }, (_, i) => ({
    start: i * 2,
    end: i * 2,
  }));
  const res1 = await reusePlan({ size: 100000, cached: tooManyCached, edits: [] });
  assert.equal(res1.statusCode, 400);

  const tooManyEdits = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({
    start: i * 3,
    deleteBytes: 0,
    insertBytes: 1,
  }));
  // size must hold all the pure insertions' distinct starts (inserts never
  // nest), so give a large resource.
  const res2 = await reusePlan({
    size: (MAX_EDITS + 1) * 3,
    cached: [],
    edits: tooManyEdits,
  });
  assert.equal(res2.statusCode, 400);

  // Module-level codes for callers that bypass the HTTP schema.
  const direct = planCacheReuse({ size: 100000, cached: tooManyCached, edits: [] });
  assert.equal(direct.statusCode, 400);
  assert.equal(direct.code, 'TOO_MANY_CACHED_INTERVALS');
  const direct2 = planCacheReuse({
    size: (MAX_EDITS + 1) * 3,
    cached: [],
    edits: tooManyEdits,
  });
  assert.equal(direct2.code, 'TOO_MANY_EDITS');
});

test('strict validator rejects string numbers, decimals and extra fields', async () => {
  const bad = [
    { size: '10', cached: [], edits: [] },
    { size: 10.5, cached: [], edits: [] },
    { size: -1, cached: [], edits: [] },
    { size: 10, cached: [], edits: [], bogus: true },
    { size: 10, cached: [], edits: [{ start: '0', deleteBytes: 1, insertBytes: 0 }] },
    { size: 10, cached: [{ start: 0, end: 1.5 }], edits: [] },
    { size: 10, cached: [{ start: 0 }], edits: [] },
  ];
  for (const payload of bad) {
    const res = await reusePlan(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('missing required fields are rejected', async () => {
  const res = await reusePlan({ cached: [], edits: [] });
  assert.equal(res.statusCode, 400);
});

test('huge coordinates work with interval arithmetic (no byte expansion)', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  // Replace the final byte of a max-size resource: size unchanged.
  const res = await reusePlan({
    size: max,
    cached: [
      { start: 0, end: 1000 },
      { start: max - 2, end: max - 1 },
    ],
    edits: [{ start: max - 1, deleteBytes: 1, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, max);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 1000, newStart: 0, newEnd: 1000 },
    { oldStart: max - 2, oldEnd: max - 2, newStart: max - 2, newEnd: max - 2 },
  ]);
  // new max-2 is reused, new max-1 is the replacement gap.
  assert.deepEqual(body.gaps, [
    { start: 1001, end: max - 3 },
    { start: max - 1, end: max - 1 },
  ]);

  // Pure insertion at 0 of a huge resource shifts a tail cache interval.
  const res2 = await reusePlan({
    size: max - 5,
    cached: [{ start: max - 7, end: max - 6 }],
    edits: [{ start: 0, deleteBytes: 0, insertBytes: 5 }],
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().newSize, max);
  assert.deepEqual(res2.json().mappings, [
    { oldStart: max - 7, oldEnd: max - 6, newStart: max - 2, newEnd: max - 1 },
  ]);

  // Delete at the head of a max-size resource.
  const res3 = await reusePlan({
    size: max,
    cached: [{ start: 0, end: max - 1 }],
    edits: [{ start: 0, deleteBytes: 3, insertBytes: 0 }],
  });
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.json().newSize, max - 3);
  assert.deepEqual(res3.json().mappings, [
    { oldStart: 3, oldEnd: max - 1, newStart: 0, newEnd: max - 4 },
  ]);
  // The whole old resource was cached, so after a deletion nothing is missing.
  assert.deepEqual(res3.json().gaps, []);
});

// ---------------------------------------------------------------------------
// Property tests: compare the interval implementation against a straightforward
// per-byte reference model on small random inputs. The byte-by-byte expansion
// lives only here in the test, never in src/.
// ---------------------------------------------------------------------------

/** Reference model: track every old/new byte explicitly. */
function referencePlan(size, cachedInput, editsInput) {
  const edits = [...editsInput].sort((a, b) => a.start - b.start);

  const deleted = new Array(size).fill(false);
  for (const edit of edits) {
    for (let x = edit.start; x < edit.start + edit.deleteBytes; x += 1) deleted[x] = true;
  }

  const shiftAt = (x) => {
    let shift = 0;
    for (const edit of edits) {
      if (edit.start <= x) shift += edit.insertBytes - edit.deleteBytes;
    }
    return shift;
  };

  // Merge cached intervals the same way (overlap/adjacency) over tiny inputs.
  const cachedSet = new Array(size).fill(false);
  const sorted = [...cachedInput].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const interval of sorted) {
    for (let x = interval.start; x <= interval.end; x += 1) cachedSet[x] = true;
  }

  let newSize = size;
  for (const edit of edits) newSize += edit.insertBytes - edit.deleteBytes;

  // newToOld[x] = old offset of the reusable byte at new offset x, else null.
  const newToOld = new Array(newSize).fill(null);
  for (let x = 0; x < size; x += 1) {
    if (!deleted[x] && cachedSet[x]) newToOld[x + shiftAt(x)] = x;
  }

  // Maximal runs of reusable new bytes whose old offsets are consecutive too.
  const mappings = [];
  let i = 0;
  while (i < newSize) {
    if (newToOld[i] === null) {
      i += 1;
      continue;
    }
    const newStart = i;
    const oldStart = newToOld[i];
    let oldCursor = oldStart;
    while (i < newSize && newToOld[i] === oldCursor) {
      oldCursor += 1;
      i += 1;
    }
    mappings.push({
      oldStart,
      oldEnd: oldCursor - 1,
      newStart,
      newEnd: i - 1,
    });
  }

  const gaps = [];
  i = 0;
  while (i < newSize) {
    if (newToOld[i] !== null) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < newSize && newToOld[i] === null) i += 1;
    gaps.push({ start, end: i - 1 });
  }

  return { newSize, mappings, gaps };
}

function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized plans match the per-byte reference model', () => {
  const rand = mulberry32(20260929);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const size = Math.floor(rand() * 40);

    // Generate valid old-coordinate edits greedily.
    const edits = [];
    const usedStarts = new Set();
    for (let attempt = 0; attempt < 25 && edits.length < 6; attempt += 1) {
      const start = Math.floor(rand() * (size + 1));
      if (usedStarts.has(start)) continue;
      if (edits.some((e) => start > e.start && start < e.start + e.deleteBytes)) continue;
      const maxDel = size - start;
      const deleteBytes = Math.floor(rand() * (maxDel + 1));
      if (edits.some((e) => e.start > start && e.start < start + deleteBytes)) continue;
      let insertBytes = Math.floor(rand() * 6);
      if (deleteBytes === 0 && insertBytes === 0) insertBytes = 1;
      usedStarts.add(start);
      edits.push({ start, deleteBytes, insertBytes });
    }

    // Random cache intervals.
    const cached = [];
    const count = Math.floor(rand() * 6);
    for (let j = 0; j < count; j += 1) {
      if (size === 0) break;
      const start = Math.floor(rand() * size);
      const end = start + Math.floor(rand() * Math.min(size - start, 6));
      cached.push({ start, end });
    }

    const result = planCacheReuse({ size, cached, edits });
    assert.equal(result.statusCode, 200, `iteration ${iteration}: ${result.message}`);

    const expected = referencePlan(size, cached, edits);
    assert.equal(result.newSize, expected.newSize, `iteration ${iteration}: newSize`);
    assert.deepEqual(result.mappings, expected.mappings, `iteration ${iteration}: mappings`);
    assert.deepEqual(result.gaps, expected.gaps, `iteration ${iteration}: gaps`);

    // Invariants that always hold.
    let reusable = 0;
    for (const mapping of result.mappings) {
      assert.equal(
        mapping.oldEnd - mapping.oldStart,
        mapping.newEnd - mapping.newStart,
        `iteration ${iteration}: mapping lengths agree`,
      );
      reusable += mapping.oldEnd - mapping.oldStart + 1;
    }
    assert.equal(result.reusableBytes, reusable, `iteration ${iteration}: reusableBytes`);
    assert.equal(result.gapBytes, result.newSize - reusable, `iteration ${iteration}: gapBytes`);
  }
});
