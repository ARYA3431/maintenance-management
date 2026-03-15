const ExcelJS = require('exceljs');
const path = require('path');

const EXCEL_FILE = path.join(__dirname, 'SMS 2 Manpower List.xlsx');
let employees = new Map();

async function loadEmployees() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_FILE);

  employees.clear();
  wb.worksheets.forEach(ws => {
    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const empId = String(row.getCell(1).value || '').trim();
      const fullName = String(row.getCell(2).value || '').trim();
      const department = String(row.getCell(3).value || '').trim();
      const email = String(row.getCell(4).value || '').trim();
      if (empId && fullName) {
        employees.set(empId, { employeeId: empId, fullName, department, email });
      }
    });
  });

  console.log(`Loaded ${employees.size} employees from Excel (${wb.worksheets.map(w => w.name).join(', ')})`);
}

function verifyEmployee(employeeId) {
  return employees.get(String(employeeId).trim()) || null;
}

module.exports = { loadEmployees, verifyEmployee };
