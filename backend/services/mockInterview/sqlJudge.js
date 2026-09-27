// Grades a candidate SQL submission against a problem's reference query,
// using Node's built-in sqlite (in-memory, one fresh DB per request — no
// state ever survives between submissions).
import { DatabaseSync } from 'node:sqlite';

// Only a single read-only SELECT is allowed: no writes, no schema changes,
// no stacked statements. The in-memory DB is thrown away after grading
// either way, but this keeps error messages meaningful and rules out
// pathological multi-statement input.
const BLOCKED = /\b(drop|delete|update|insert|alter|attach|detach|pragma|vacuum|replace|create|reindex)\b/i;

function assertSafeSelect(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed)) throw new Error('Only a SELECT query is allowed here.');
  if (trimmed.includes(';')) throw new Error('Only a single statement is allowed.');
  if (BLOCKED.test(trimmed)) throw new Error('Only read-only SELECT queries are allowed here.');
  return trimmed;
}

const normalizeRows = rows => rows.map(r => JSON.stringify(Object.values(r).map(v => (v == null ? null : String(v)))));

export function gradeSqlSubmission({ schema, checkQuery, candidateQuery, orderMatters }) {
  const safeCandidate = assertSafeSelect(candidateQuery);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    let candidateRows;
    try {
      candidateRows = db.prepare(safeCandidate).all();
    } catch (err) {
      return { ok: false, error: `Query error: ${err.message}` };
    }
    const expectedRows = db.prepare(checkQuery).all();
    const a = normalizeRows(candidateRows);
    const b = normalizeRows(expectedRows);
    const pass = orderMatters
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
    return { ok: pass, rowCount: candidateRows.length, expectedRowCount: expectedRows.length };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    db.close();
  }
}
