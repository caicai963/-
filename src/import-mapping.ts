import { readExcel, readCSV } from './reader';
import { readSheetByShareLink } from './feishu';
import { importMappings, OrderMapping, closeDb } from './db';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

interface MappingConfig {
  type: 'local' | 'feishu_share' | 'popo_doc';
  local?: { file: string };
  feishu_share?: { shareLink: string; sheetName?: string };
  popo_doc?: { docId: string };
  columns: { external_order_no: string; internal_order_no: string };
}

interface SheetRow {
  [key: string]: string | number | undefined;
}

function loadMappingConfig(): MappingConfig {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '..', 'config', 'epc.json'), 'utf-8'));
  return raw.mapping;
}

function readPopoSpreadsheet(docId: string): SheetRow[] {
  console.log(`从POPO在线表格读取: ${docId}`);

  const cmdJson = '{"type":"workbook.getFullData","payload":{}}';
  const tmpFile = resolve(tmpdir(), 'popo_epc_cmd.json');
  writeFileSync(tmpFile, cmdJson, 'utf-8');

  const cmd = `popo-cli popo doc_execute_table docId=${docId} command="@file:${tmpFile}"`;
  let output: string;
  try {
    output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    throw new Error(`POPO表格读取失败: ${err.stderr || err.message}`);
  }

  const result = JSON.parse(output);
  if (!result.ok) {
    throw new Error(`POPO表格读取失败: ${result.error || JSON.stringify(result)}`);
  }

  function findSheets(obj: any, depth: number): any {
    if (!obj || depth > 15) return null;
    if (obj.sheets) return obj;
    if (obj.data) return findSheets(obj.data, depth + 1);
    return null;
  }

  const data = findSheets(result, 0);

  if (!data || !data.sheets || data.sheets.length === 0) {
    const preview = JSON.stringify(result).substring(0, 500);
    throw new Error(`POPO表格为空 (preview: ${preview})`);
  }

  const sheet = data.sheets[0];
  const cells: Record<string, string | number> = sheet.cells || {};
  const rowCount = sheet.rowCount || 0;
  const colCount = sheet.colCount || 0;

  if (rowCount < 2) {
    throw new Error('POPO表格无数据（需要表头+至少1行数据）');
  }

  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headers.push(String(cells[`0,${c}`] || `col_${c}`).trim());
  }

  const rows: SheetRow[] = [];
  for (let r = 1; r < rowCount; r++) {
    const row: SheetRow = {};
    let hasData = false;
    for (let c = 0; c < colCount; c++) {
      const val = cells[`${r},${c}`];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        hasData = true;
      }
      row[headers[c]] = val !== undefined && val !== null ? String(val).trim() : undefined;
    }
    if (hasData) rows.push(row);
  }

  return rows;
}

function parseRows(rows: SheetRow[], cols: MappingConfig['columns']): OrderMapping[] {
  const mappings: OrderMapping[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const external = String(row[cols.external_order_no] || '').trim();
    const internal = String(row[cols.internal_order_no] || '').trim();
    if (!external || !internal) { console.warn(`跳过不完整行`); continue; }
    if (seen.has(external)) { console.warn(`重复: ${external}`); continue; }
    seen.add(external);
    mappings.push({ external_order_no: external, internal_order_no: internal });
  }
  return mappings;
}

export async function runImport(filePath?: string): Promise<{ inserted: number; skipped: number }> {
  const config = loadMappingConfig();
  let rows: SheetRow[] = [];

  if (config.type === 'popo_doc' && config.popo_doc) {
    const { docId } = config.popo_doc;
    if (!docId || docId === 'YOUR_DOC_ID') {
      console.log('POPO映射表未配置 docId，跳过');
      return { inserted: 0, skipped: 0 };
    }
    rows = readPopoSpreadsheet(docId);
  } else if (config.type === 'feishu_share' && config.feishu_share) {
    const { shareLink, sheetName } = config.feishu_share;
    if (!shareLink || shareLink.includes('xxx.feishu.cn')) {
      console.log('飞书映射表未配置，跳过');
      return { inserted: 0, skipped: 0 };
    }
    console.log(`从飞书读取映射表: ${shareLink}`);
    rows = await readSheetByShareLink(shareLink, sheetName);
  } else {
    const defaultPath = config.local?.file || './data/mapping.xlsx';
    const mappingPath = filePath || resolve(__dirname, '..', defaultPath);

    if (!existsSync(mappingPath)) {
      console.log(`映射文件不存在: ${mappingPath}`);
      console.log('请创建映射表（两列: 外部单号, 内部单号），或切换到POPO/飞书在线表格');
      return { inserted: 0, skipped: 0 };
    }

    console.log(`读取本地映射: ${mappingPath}`);
    const ext = extname(mappingPath).toLowerCase();
    rows = ext === '.csv' ? readCSV(mappingPath) : readExcel(mappingPath);
  }

  console.log(`读取 ${rows.length} 行`);
  const mappings = parseRows(rows, config.columns);
  console.log(`解析 ${mappings.length} 条有效映射`);

  const result = importMappings(mappings);
  console.log(`导入: ${result.inserted} 条, 跳过 ${result.skipped} 条`);
  closeDb();
  return result;
}

if (require.main === module) {
  const fileArg = process.argv[2];
  runImport(fileArg).then(
    () => process.exit(0),
    (e) => { console.error('导入失败:', e.message); process.exit(1); }
  );
}
