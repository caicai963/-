import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

export interface RecordRow {
  [key: string]: string | number | undefined;
}

export function readExcel(filePath: string, sheetName?: string): RecordRow[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`数据文件不存在: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath, { type: 'file' });
  const sheet = sheetName
    ? workbook.Sheets[sheetName]
    : workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet) {
    throw new Error(
      `工作表 "${sheetName || workbook.SheetNames[0]}" 不存在，可用的工作表: ${workbook.SheetNames.join(', ')}`
    );
  }

  const data: RecordRow[] = XLSX.utils.sheet_to_json(sheet, { defval: undefined, raw: false });
  return data;
}

export function readCSV(filePath: string): RecordRow[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`数据文件不存在: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const workbook = XLSX.read(content, { type: 'string', raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: undefined, raw: false });
}

export function mapColumns(
  rawData: RecordRow[],
  columnMapping: Record<string, string>
): RecordRow[] {
  const reverseMapping: Record<string, string> = {};
  for (const [cn, en] of Object.entries(columnMapping)) {
    reverseMapping[en] = cn;
  }

  return rawData.map((row) => {
    const mapped: RecordRow = {};
    for (const [cn, en] of Object.entries(columnMapping)) {
      mapped[en] = row[cn];
    }
    return mapped;
  });
}
