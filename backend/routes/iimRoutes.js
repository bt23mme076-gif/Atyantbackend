import express from 'express';
import { getSheetData } from '../utils/googleSheets.js';

const router = express.Router();
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// GET /api/iim/professors/:campus — campus is the sheet tab name.
router.get('/professors/:campus', async (req, res) => {
  const { campus } = req.params;
  const hit = cache.get(campus);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.data);

  const rows = await getSheetData(campus);
  if (!rows) return res.status(502).json({ error: 'Could not load professors' });
  if (rows.length < 2) return res.json([]);

  const headers = rows[0].map((h) => String(h).trim());
  const professors = rows.slice(1).map((row) => {
    const prof = {};
    headers.forEach((h, i) => { prof[h] = row[i] || ''; });
    return prof;
  });
  cache.set(campus, { at: Date.now(), data: professors });
  res.json(professors);
});

export default router;
