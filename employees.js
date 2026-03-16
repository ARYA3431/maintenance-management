const ExcelJS = require('exceljs');
const path = require('path');

const EXCEL_FILE = path.join(__dirname, 'SMS 2 Manpower List.xlsx');
let employees = new Map();

async function loadEmployees() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(EXCEL_FILE)) {
      console.log('Excel file not found, skipping employee load.');
      return;
    }
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
  } catch (err) {
    console.error('Warning: Could not load employees from Excel:', err.message);
  }
}

function verifyEmployee(employeeId) {
  return employees.get(String(employeeId).trim()) || null;
}

function getAllEmployees() {
  return Array.from(employees.values());
}

module.exports = { loadEmployees, verifyEmployee, getAllEmployees };
