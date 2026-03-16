const ExcelJS = require('exceljs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'store_list.xlsx');
let storeItems = [];

async function loadStoreList() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(STORE_FILE)) {
      console.log('store_list.xlsx not found, skipping store load.');
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(STORE_FILE);

    storeItems = [];

    wb.worksheets.forEach(ws => {
      const sheetName = ws.name.trim();
      // Determine location type and number from sheet name
      const locInfo = parseLocationFromSheet(sheetName);

      // Find the header row (look for row containing "MATERIAL" in any cell)
      let headerRow = -1;
      let colMap = {};

      for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
        const row = ws.getRow(r);
        row.eachCell({ includeEmpty: false }, (cell, colNum) => {
          const val = String(cell.value || '').toUpperCase().trim();
          if (val.includes('MATERIAL') && (val.includes('DESC') || val.includes('DISC'))) {
            colMap.material = colNum;
            headerRow = r;
          }
          if (val === 'RACK NO.' || val === 'RACK NO') colMap.rack = colNum;
          if (val.includes('SUB') && (val.includes('RACK') || val.includes('CUPBOARD'))) colMap.sub = colNum;
          if (val === 'BOX NO.' || val === 'BOX NO') colMap.box = colNum;
          if (val === 'SR NO' || val === 'SR NO.') colMap.sr = colNum;
          if (val.includes('QTY') || val.includes('QUAN') || val === 'QTY') colMap.qty = colNum;
          if (val.includes('MLFB') || val.includes('ITEM CODE') || val.includes('MODEL')) colMap.code = colNum;
          if (val === 'STATUS') colMap.status = colNum;
        });
        if (headerRow > 0) break;
      }

      if (headerRow < 0) {
        // Try row 2 as header (common pattern in this Excel)
        headerRow = 2;
        const row2 = ws.getRow(2);
        row2.eachCell({ includeEmpty: false }, (cell, colNum) => {
          const val = String(cell.value || '').toUpperCase().trim();
          if (val.includes('MATERIAL') && (val.includes('DESC') || val.includes('DISC'))) colMap.material = colNum;
          if (val === 'RACK NO.' || val === 'RACK NO') colMap.rack = colNum;
          if (val.includes('SUB') && (val.includes('RACK') || val.includes('CUPBOARD'))) colMap.sub = colNum;
          if (val === 'BOX NO.' || val === 'BOX NO.') colMap.box = colNum;
          if (val === 'SR NO' || val === 'SR NO.') colMap.sr = colNum;
          if (val.includes('QTY') || val.includes('QUAN') || val === 'QTY') colMap.qty = colNum;
          if (val.includes('MLFB') || val.includes('ITEM CODE') || val.includes('MODEL')) colMap.code = colNum;
          if (val === 'STATUS') colMap.status = colNum;
        });
      }

      // Skip sheets with no material column found or special sheets
      if (!colMap.material) {
        // For Sheet1 (cable drum list) — just grab single column items
        if (sheetName === 'Sheet1') {
          for (let r = 1; r <= ws.rowCount; r++) {
            const val = String(ws.getRow(r).getCell(1).value || '').trim();
            if (val && val !== 'K&S  Type Cable Drum') {
              storeItems.push({
                location: 'Cable Drum Storage',
                locationType: 'Other',
                sub: '',
                position: String(r - 1),
                material: val,
                code: '',
                quantity: '',
                status: ''
              });
            }
          }
        }
        return;
      }

      // Track last known rack/sub values for merged cells
      let lastRack = locInfo.number || '';
      let lastSub = '';

      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const material = String(row.getCell(colMap.material).value || '').trim();
        if (!material) continue; // skip empty rows

        // Get values, using last known for merged/empty cells
        let rack = colMap.rack ? String(row.getCell(colMap.rack).value || '').trim() : '';
        let sub = colMap.sub ? String(row.getCell(colMap.sub).value || '').trim() : '';
        const box = colMap.box ? String(row.getCell(colMap.box).value || '').trim() : '';
        const sr = colMap.sr ? String(row.getCell(colMap.sr).value || '').trim() : '';
        const qty = colMap.qty ? String(row.getCell(colMap.qty).value || '').trim() : '';
        const code = colMap.code ? String(row.getCell(colMap.code).value || '').trim() : '';
        const status = colMap.status ? String(row.getCell(colMap.status).value || '').trim() : '';

        if (rack) lastRack = rack; else rack = lastRack;
        if (sub) lastSub = sub; else sub = lastSub;

        const position = box || sr || '';

        storeItems.push({
          location: locInfo.displayName || sheetName,
          locationType: locInfo.type,
          sub: sub,
          position: position,
          material: material,
          code: code,
          quantity: qty,
          status: status
        });
      }
    });

    console.log(`Loaded ${storeItems.length} store items from store_list.xlsx`);
  } catch (err) {
    console.error('Warning: Could not load store list:', err.message);
  }
}

function parseLocationFromSheet(name) {
  const upper = name.toUpperCase().replace(/\s+/g, '');
  if (upper.startsWith('RACK') || upper === 'RACK') {
    return { type: 'Rack', number: '1', displayName: 'Rack 01' };
  }
  // Match cupboard/copboard variations with number
  const cupMatch = upper.match(/(?:CUPBOARD|COPBOARD)\s*-?\s*(\d+)/i) || name.match(/(?:cupboard|Cupboard)\s*(\d+)/i);
  if (cupMatch) {
    const num = cupMatch[1].padStart(2, '0');
    return { type: 'Cupboard', number: num, displayName: `Cupboard ${num}` };
  }
  if (upper.includes('CUPBOARD') || upper.includes('COPBOARD')) {
    return { type: 'Cupboard', number: '', displayName: name };
  }
  if (upper.includes('SCRAP')) {
    return { type: 'Scrap', number: '', displayName: 'Scrap Material' };
  }
  // Sheet2, Sheet3, Sheet4 are actually additional rack data
  const sheetMatch = upper.match(/^SHEET(\d)$/);
  if (sheetMatch) {
    const rackMap = { '4': '4', '2': '2', '3': '3' };
    const rNum = rackMap[sheetMatch[1]] || sheetMatch[1];
    return { type: 'Rack', number: rNum, displayName: `Rack ${rNum.padStart(2, '0')}` };
  }
  return { type: 'Other', number: '', displayName: name };
}

function getStoreItems() {
  return storeItems;
}

function searchStore(query) {
  if (!query) return storeItems;
  const q = query.toLowerCase();
  return storeItems.filter(item =>
    item.material.toLowerCase().includes(q) ||
    item.location.toLowerCase().includes(q) ||
    item.code.toLowerCase().includes(q) ||
    item.sub.toLowerCase().includes(q)
  );
}

function getStoreLocations() {
  const locations = new Map();
  storeItems.forEach(item => {
    if (!locations.has(item.location)) {
      locations.set(item.location, { name: item.location, type: item.locationType, count: 0 });
    }
    locations.get(item.location).count++;
  });
  return Array.from(locations.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });
}

module.exports = { loadStoreList, getStoreItems, searchStore, getStoreLocations };
