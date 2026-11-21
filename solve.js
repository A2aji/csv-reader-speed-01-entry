// csv-reader-speed-01: a fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Same answers as csv-reader 1.0.0 for every input; written for speed.
//
// Two paths:
//  - Fast path: a record whose line holds no quote ends at the next line break, so its
//    fields come from one native split(',') — no per-character work at all. A stray CR
//    inside such a line is dropped with one stray_cr error each, exactly as the
//    reference does while reading the field.
//  - Slow path: a record that opens a quoted field. Quoted fields are found with
//    indexOf('"'), their bodies sliced (never built a character at a time); unquoted
//    fields are found with one regex scan for the next comma, CR or LF. CRLF and lone
//    CR inside quotes each become one LF, and the line count follows the reference.
//
// Every rule of the reference is kept: U+FEFF dropped at the very start, empty lines
// are no records, a lone CR outside quotes is dropped (stray_cr), a quote that never
// closes is literal and the text after it is re-read as unquoted (unterminated_quote),
// junk after a closing quote is appended as it stands (quote_junk), a quote inside an
// unquoted field is literal, fields stay strings, rows are padded (short_row) or cut
// (long_row) to the first record's width, and errors carry the line the record starts
// on and its index in rows (null for the header), in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next comma, CR or LF at or after the regex's lastIndex: one native scan. */
const DELIM = /[,\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  // Index of the next LF at or after pos, -1 when none or unknown: unquoted fields
  // end at a comma or at this LF, so one indexOf(',') finds the field's end.
  let lineEnd = -1;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted segment with its CRLF and lone CRs read as LF, counting the lines it spans.
  function fixBreaks(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) return seg;
      let c = 0;
      let i = -1;
      while ((i = seg.indexOf('\n', i + 1)) !== -1) c++;
      line += c;
      return seg;
    }
    let out = '';
    let last = 0;
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charCodeAt(i);
      if (ch === 13) {
        out += seg.slice(last, i);
        out += '\n';
        line++;
        if (seg.charCodeAt(i + 1) === 10) i++;
        last = i + 1;
      } else if (ch === 10) {
        out += seg.slice(last, i);
        out += '\n';
        line++;
        last = i + 1;
      }
    }
    return out + seg.slice(last);
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns the field and how it ended; `added`
  // counts the characters kept (a quote_junk check reads it). The field ends at the
  // next comma or at lineEnd, so one indexOf(',') finds it; a CR inside it is found
  // on the slice, never by scanning past the field.
  function readUnquoted(value, added) {
    let parts = null;
    for (;;) {
      let le = lineEnd;
      if (le === -1 || le < pos) {
        le = text.indexOf('\n', pos);
        lineEnd = le;
      }
      const ci = text.indexOf(',', pos);
      let m;
      let kind;
      if (le === -1) {
        if (ci === -1) {
          m = n;
          kind = END;
        } else {
          m = ci;
          kind = COMMA;
        }
      } else if (ci === -1 || ci > le) {
        m = le;
        kind = LINE_BREAK;
      } else {
        m = ci;
        kind = COMMA;
      }
      const seg = text.slice(pos, m);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        added += seg.length;
        if (kind === COMMA) pos = m + 1;
        else if (kind === LINE_BREAK) {
          pos = m + 1;
          line++;
        } else {
          pos = n;
        }
        if (parts !== null) value = parts.join('') + value;
        return { value: value + seg, ended: kind, added };
      }
      const rpos = pos + ri;
      if (text.charCodeAt(rpos + 1) === 10) {
        // CRLF ends the field as one line break.
        const head = seg.slice(0, ri);
        added += head.length;
        pos = rpos + 2;
        line++;
        lineEnd = -1;
        if (parts !== null) value = parts.join('') + value;
        return { value: value + head, ended: LINE_BREAK, added };
      }
      // A stray CR: dropped, recorded, and the field goes on.
      pushError('stray_cr');
      const head = seg.slice(0, ri);
      added += head.length;
      if (parts === null) parts = [value, head];
      else parts.push(head);
      value = '';
      pos = rpos + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    lineEnd = -1;
    let start = pos + 1;
    let parts = null;
    for (;;) {
      const q = text.indexOf('"', start);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted('"', 0);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote; the field goes on.
        const seg = fixBreaks(text.slice(start, q));
        if (parts === null) parts = [seg, '"'];
        else parts.push(seg, '"');
        start = q + 2;
        continue;
      }
      const seg = fixBreaks(text.slice(start, q));
      let value;
      if (parts === null) value = seg;
      else {
        parts.push(seg);
        value = parts.join('');
      }
      pos = q + 1;
      if (pos >= n) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos++;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos++;
        line++;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the next comma
      // or line break.
      const junk = readUnquoted(value, 0);
      if (junk.added > 0) pushError('quote_junk');
      return junk;
    }
  }

  // Ends a record: a line that held only stray CRs is left with no characters: no
  // record (its stray_cr errors stay). The header takes no short_row/long_row check.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: no quote before the next line break, so this record ends there.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    lineEnd = nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= segEnd) {
      let seg = text.slice(pos, segEnd);
      const hasBreak = nl !== -1;
      if (hasBreak && seg.charCodeAt(seg.length - 1) === 13) seg = seg.slice(0, -1);
      let fields;
      if (seg.indexOf('\r') === -1) {
        fields = seg.split(',');
      } else {
        // Stray CRs, one error each, in field order; the CRs are dropped.
        fields = seg.split(',');
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          if (f.indexOf('\r') !== -1) {
            let count = 0;
            let idx = -1;
            while ((idx = f.indexOf('\r', idx + 1)) !== -1) count++;
            for (let k = 0; k < count; k++) pushError('stray_cr');
            fields[i] = f.replace(/\r/g, '');
          }
        }
      }
      pos = hasBreak ? nl + 1 : n;
      if (hasBreak) line++;
      finishRecord(fields, false);
      continue;
    }

    // Slow path: a quoted field opens in this record.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('', 0);
      fields.push(field.value);
    } while (field.ended === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
