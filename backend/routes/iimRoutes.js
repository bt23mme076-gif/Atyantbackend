// routes/iimRoutes.js
import express from 'express';
import { getSheetData } from '../utils/googleSheets.js'; // Ab ye mil jayega

const router = express.Router();

router.get('/professors/:campus', async (req, res) => {
  const { campus } = req.params;
  const data = await getSheetData(campus);
  
  if (data && data.length > 1) {
    // First row is header
    const headers = data[0];
    const professors = data.slice(1).map(row => {
      const prof = {};
      headers.forEach((header, i) => {
        prof[header.trim()] = row[i] || '';
      });
      return prof;
    });
    res.json(professors);
  } else {
    res.status(500).json({ error: "Data fetch nahi ho paya" });
  }
});

export default router;