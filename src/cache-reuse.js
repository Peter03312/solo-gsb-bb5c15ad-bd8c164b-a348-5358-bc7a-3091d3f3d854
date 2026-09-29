// Sparse-cache reuse planner for in-place resource edits.
//
// A resource is edited by a list of edits expressed in OLD coordinates: at
// `start`, `deleteBytes` old bytes are removed and `insertBytes` new bytes are
// inserted; bytes outside the edited spans keep their identity. Given the old
// resource size and the closed byte intervals already held in a sparse cache
// (unordered, overlapping or adjacent), compute:
//
//   - the new resource size;
//   - which still-existing old cached intervals are reusable at which new
//     offsets (deleted bytes are never reused; inserted bytes are always a
//     gap). A mapping splits at every edit; two mappings merge back only when
//     they are adjacent in BOTH old and new coordinates;
//   - the new resource's gaps (closed intervals that must be (re)fetched),
//     merged ascending.
//
// Everything here is interval arithmetic over endpoints. Resources may be as
// large as 2^53-1 bytes, so no byte is ever materialized or looped over.

export const MAX_CACHED_INTERVALS = 1000;
export const MAX_EDITS = 1000;

/**
 * Plan reuse of a sparse cache after edits.
 *
 * @returns a 200 result carrying the new size, old→new reusable-interval
 *          mappings and the new resource's gaps, or a 400 result describing
 *          the first validation failure.
 */
export function planCacheReuse(options) {
  const { size, cached, edits } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }

  const cachedError = validateCached(cached, size);
  if (cachedError) return cachedError;
  const editsError = validateEdits(edits, size);
  if (editsError) return editsError;

  // Edits may arrive in any order; all coordinate rules below assume starts
  // ascending. Equal starts are rejected, so the secondary key only exists to
  // keep the sort deterministic.
  const sortedEdits = edits
    .map((edit) => ({ ...edit }))
    .sort((a, b) => a.start - b.start || a.deleteBytes - b.deleteBytes);

  for (let i = 1; i < sortedEdits.length; i += 1) {
    const prev = sortedEdits[i - 1];
    const current = sortedEdits[i];
    if (current.start === prev.start) {
      return fail(
        'DUPLICATE_EDIT_START',
        `two edits start at offset ${current.start}; every edit start must be unique`,
      );
    }
    // Equality is allowed: an edit beginning exactly where the previous
    // deletion ends is a plain boundary, not an edit nested inside a deletion.
    if (current.start < prev.start + prev.deleteBytes) {
      return fail(
        'EDIT_INSIDE_DELETION',
        `edit at ${current.start} starts inside the previous edit's deletion range ` +
          `[${prev.start}, ${prev.start + prev.deleteBytes - 1}]`,
      );
    }
  }

  // Apply the edits to the size before any coordinate math. Deletions never
  // underflow: the nesting rejection makes every deletion range a disjoint
  // subset of the old resource, so their total is at most `size`. Insertions
  // are guarded one by one so the new size stays an exact safe integer.
  let newSize = size;
  for (const edit of sortedEdits) {
    newSize -= edit.deleteBytes;
    if (edit.insertBytes > Number.MAX_SAFE_INTEGER - newSize) {
      return fail(
        'NEW_SIZE_OVERFLOW',
        `the edits would grow the resource past ${Number.MAX_SAFE_INTEGER} bytes`,
      );
    }
    newSize += edit.insertBytes;
  }

  const mergedCache = mergeIntervals(cached);

  // Map the merged cache across the edits with a single ascending sweep.
  // Invariant between cache intervals: `shift` (newOffset - oldOffset for a
  // preserved byte) already contains every edit whose deletion ends at or
  // before the current sweep position, and `editIndex` points just past it.
  // An edit whose deletion straddles a cache interval end is left pending:
  // later cache intervals starting inside that same deletion are skipped too.
  // Both lists are ascending and disjoint, so this is a linear merge with no
  // byte expansion.
  const mappings = [];
  let shift = 0;
  let editIndex = 0;

  for (const interval of mergedCache) {
    let cur = interval.start;
    const end = interval.end;

    while (
      editIndex < sortedEdits.length &&
      sortedEdits[editIndex].start + sortedEdits[editIndex].deleteBytes <= cur
    ) {
      const edit = sortedEdits[editIndex];
      shift += edit.insertBytes - edit.deleteBytes;
      editIndex += 1;
    }

    while (editIndex < sortedEdits.length && sortedEdits[editIndex].start <= end) {
      const edit = sortedEdits[editIndex];

      if (edit.start > cur) {
        pushMapping(mappings, cur, edit.start - 1, shift);
      }
      // The deleted span [edit.start, edit.start + deleteBytes - 1] produces
      // no mapping; deleted bytes are never reusable.
      cur = edit.start + edit.deleteBytes;
      if (cur > end) {
        // The deletion reaches past this interval (and may cover the next
        // cache intervals as well). Leave the edit pending and stop; cur is
        // intentionally beyond `end` so nothing of this interval is emitted.
        cur = end + 1;
        break;
      }
      shift += edit.insertBytes - edit.deleteBytes;
      editIndex += 1;
    }

    if (cur <= end) {
      pushMapping(mappings, cur, end, shift);
    }
  }

  // Re-join mappings that an edit split only nominally; this requires
  // adjacency in both coordinates, so a pure insertion (adjacent old bytes,
  // new gap between) and a pure deletion (new-adjacent, old gap) stay split.
  const mergedMappings = [];
  for (const piece of mappings) {
    const last = mergedMappings[mergedMappings.length - 1];
    if (
      last &&
      piece.oldStart === last.oldEnd + 1 &&
      piece.newStart === last.newEnd + 1
    ) {
      last.oldEnd = piece.oldEnd;
      last.newEnd = piece.newEnd;
    } else {
      mergedMappings.push({ ...piece });
    }
  }

  const reusableBytes = mergedMappings.reduce(
    (sum, mapping) => sum + (mapping.oldEnd - mapping.oldStart + 1),
    0,
  );

  // Gaps are the complement of the mapped new intervals over the new resource;
  // taking the complement against ascending disjoint intervals already merges
  // adjacent gaps (inserted bytes next to previously uncached bytes).
  const gaps = [];
  let cursor = 0;
  for (const mapping of mergedMappings) {
    if (mapping.newStart > cursor) {
      gaps.push({ start: cursor, end: mapping.newStart - 1 });
    }
    cursor = mapping.newEnd + 1;
  }
  if (cursor < newSize) {
    gaps.push({ start: cursor, end: newSize - 1 });
  }

  const gapBytes = newSize - reusableBytes;

  // Disjoint deletion ranges make the per-edit totals sum to the exact totals.
  const deletedBytes = sortedEdits.reduce((sum, edit) => sum + edit.deleteBytes, 0);
  const insertedBytes = sortedEdits.reduce((sum, edit) => sum + edit.insertBytes, 0);

  return {
    statusCode: 200,
    oldSize: size,
    newSize,
    deletedBytes,
    insertedBytes,
    mappings: mergedMappings,
    reusableBytes,
    gaps,
    gapBytes,
  };
}

function pushMapping(mappings, oldStart, oldEnd, shift) {
  mappings.push({
    oldStart,
    oldEnd,
    newStart: oldStart + shift,
    newEnd: oldEnd + shift,
  });
}

function validateCached(cached, size) {
  if (!Array.isArray(cached)) {
    return fail('INVALID_CACHED', 'cached must be an array of {start, end} intervals');
  }
  if (cached.length > MAX_CACHED_INTERVALS) {
    return fail(
      'TOO_MANY_CACHED_INTERVALS',
      `cached carries ${cached.length} intervals; at most ${MAX_CACHED_INTERVALS} are allowed`,
    );
  }
  for (let i = 0; i < cached.length; i += 1) {
    const interval = cached[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].end must be a non-negative safe integer`);
    }
    if (start > end) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] has start ${start} after end ${end}`);
    }
    // This also enforces "size 0 implies an empty cache": no interval fits in
    // an empty resource.
    if (end >= size) {
      return fail(
        'CACHED_RANGE_OUT_OF_BOUNDS',
        `cached[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }
  return null;
}

function validateEdits(edits, size) {
  if (!Array.isArray(edits)) {
    return fail('INVALID_EDITS', 'edits must be an array of {start, deleteBytes, insertBytes} entries');
  }
  if (edits.length > MAX_EDITS) {
    return fail(
      'TOO_MANY_EDITS',
      `edits carries ${edits.length} entries; at most ${MAX_EDITS} are allowed`,
    );
  }
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      return fail(
        'INVALID_EDIT',
        `edits[${i}] must be an object with start, deleteBytes and insertBytes`,
      );
    }
    const { start, deleteBytes, insertBytes } = edit;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_EDIT', `edits[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(deleteBytes) || deleteBytes < 0) {
      return fail('INVALID_EDIT', `edits[${i}].deleteBytes must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(insertBytes) || insertBytes < 0) {
      return fail('INVALID_EDIT', `edits[${i}].insertBytes must be a non-negative safe integer`);
    }
    if (deleteBytes === 0 && insertBytes === 0) {
      return fail('EMPTY_EDIT', `edits[${i}] neither deletes nor inserts any bytes`);
    }
    // start === size is legal: a pure tail insertion. The subtraction only
    // runs when start <= size, so its result is an exact non-negative int.
    if (start > size || deleteBytes > size - start) {
      return fail(
        'EDIT_OUT_OF_BOUNDS',
        `edits[${i}] deletes ${deleteBytes} bytes at ${start}, beyond the ${size}-byte resource`,
      );
    }
  }
  return null;
}

/**
 * Sort closed intervals by start offset and merge overlapping or adjacent
 * ones ([0-9] and [10-19] merge into [0-19]).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
