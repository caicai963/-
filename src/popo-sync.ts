import { execSync } from 'child_process';
import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { upsertPayments, EpcPayment, getStats } from './db';

const POPO_DOC_ID = '7380efa1b4c44f1fadffd703f47ad471';
const SHEET_ID = '1';
const MAPPING_SHEET_ID = '0';

function popoExec(command: object): string {
  const cmdJson = JSON.stringify(command);
  const tmpFile = resolve(tmpdir(), `popo_epc_sync_${Date.now()}.json`);
  writeFileSync(tmpFile, cmdJson, 'utf-8');
  try {
    return execSync(`popo-cli popo doc_execute_table docId=${POPO_DOC_ID} command="@file:${tmpFile}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch {}
  }
}

function readSheetData(sheetId: string): { cells: Record<string, any>; rowCount: number; colCount: number } {
  const output = popoExec({ type: 'workbook.getFullData', payload: { sheetId } });
  const data = parsePopoResult(output);
  if (!data?.sheets?.[0]) throw new Error(`读取Sheet${sheetId}失败`);
  const sheet = data.sheets[0];
  const cells: Record<string, any> = sheet.cells || {};
  let maxRow = 0;
  for (const key of Object.keys(cells)) {
    const r = parseInt(key.split(',')[0]);
    if (!isNaN(r) && r > maxRow) maxRow = r;
  }
  return { cells, rowCount: maxRow + 1, colCount: sheet.colCount || 0 };
}

function parsePopoResult(output: string): any {
  const result = JSON.parse(output);
  let node: any = result;
  for (let i = 0; i < 10 && node && !node.sheets; i++) node = node.data;
  return node;
}

export function readSheet1Data(): { cells: Record<string, any>; rowCount: number; colCount: number } {
  return readSheetData(SHEET_ID);
}

export function appendToSheet2(records: Omit<EpcPayment, 'updated_at'>[], submitter: string): void {
  const { cells: existingCells, rowCount } = readSheet1Data();

  const headers = ['epc单号', '姓名', '手机号', '金额', '实收金额', '当前节点', '状态说明', '是否已支付', '支付时间', '提交人'];
  let headerRow = 0;

  const headerCells: Record<string, string> = {};
  for (let c = 0; c < headers.length; c++) {
    headerCells[`${headerRow},${c}`] = headers[c];
  }

  const hasHeaders = Object.entries(headerCells).every(([key, val]) => {
    const existing = String(existingCells[key] || '').trim();
    return existing === val;
  });

  const epcRowMap = new Map<string, number>();
  if (hasHeaders) {
    for (let r = 1; r < rowCount; r++) {
      const epcNo = String(existingCells[`${r},0`] || '').trim();
      if (epcNo) epcRowMap.set(epcNo, r);
    }
  }

  const cells: { row: number; col: number; value: string }[] = [];

  if (!hasHeaders) {
    for (let c = 0; c < headers.length; c++) {
      cells.push({ row: 0, col: c, value: headers[c] });
    }
  }

  let newRows = 0;
  let updatedRows = 0;
  let nextRow = rowCount;

  for (const rec of records) {
    const values = [
      rec.internal_order_no || '',
      rec.payee_name || '',
      rec.payee_phone || '',
      rec.amount != null ? String(rec.amount) : '',
      rec.actual_amount != null ? String(rec.actual_amount) : '',
      rec.status_node || '',
      rec.status_text || '',
      rec.paid ? '是' : '否',
      rec.paid_time || '',
      submitter,
    ];

    const existingRow = epcRowMap.get(rec.internal_order_no);
    const targetRow = existingRow !== undefined ? existingRow : nextRow;
    if (existingRow !== undefined) {
      updatedRows++;
    } else {
      newRows++;
      nextRow++;
    }

    for (let c = 0; c < values.length; c++) {
      cells.push({ row: targetRow, col: c, value: values[c] });
    }
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < cells.length; i += BATCH_SIZE) {
    const batch = cells.slice(i, i + BATCH_SIZE);
    console.log(`  同步到POPO: ${i + 1}-${Math.min(i + BATCH_SIZE, cells.length)}/${cells.length}`);
    const resp = popoExec({ type: 'sheet.batchSetCells', payload: { sheetId: SHEET_ID, cells: batch } });
    const r = JSON.parse(resp);
    let ok = false;
    let node: any = r;
    for (let d = 0; d < 10 && node; d++) { if (node.status === 1) { ok = true; break; } if (node.data) node = node.data; else break; }
    if (!ok) {
      const snippet = JSON.stringify(r).substring(0, 200);
      throw new Error(`POPO写入失败: ${snippet}`);
    }
  }

  console.log(`  POPO同步完成，更新 ${updatedRows} 行，新增 ${newRows} 行`);
}

export function writeUnmappedToSheet1(unmappedOrders: string[]): void {
  if (unmappedOrders.length === 0) return;

  const { cells, rowCount } = readSheetData(MAPPING_SHEET_ID);

  const existingEpcs = new Set<string>();
  let lastDataRow = 0;
  for (let r = 0; r < rowCount; r++) {
    const colA = String(cells[`${r},0`] || '').trim();
    const colB = String(cells[`${r},1`] || '').trim();
    if (colB) existingEpcs.add(colB);
    if (colA || colB) lastDataRow = r;
  }

  const newOrders = unmappedOrders.filter(o => !existingEpcs.has(o));
  if (newOrders.length === 0) {
    console.log('  所有未映射单号已存在于Sheet1');
    return;
  }

  const batch: { row: number; col: number; value: string }[] = [];
  let nextRow = lastDataRow + 1;
  for (const orderNo of newOrders) {
    batch.push({ row: nextRow, col: 1, value: orderNo });
    nextRow++;
  }

  console.log(`  写入 ${newOrders.length} 个未映射单号到Sheet1 B列（sheetId=${MAPPING_SHEET_ID}，从第${lastDataRow + 1}行开始）...`);
  const resp = popoExec({ type: 'sheet.batchSetCells', payload: { sheetId: MAPPING_SHEET_ID, cells: batch } });
  const r = JSON.parse(resp);
  let ok = false;
  let node: any = r;
  for (let d = 0; d < 10 && node; d++) { if (node.status === 1) { ok = true; break; } if (node.data) node = node.data; else break; }
  if (!ok) throw new Error(`写入未映射单号失败: ${JSON.stringify(r).substring(0, 200)}`);
  console.log(`  Sheet1已更新，请在A列填写对应外单号`);
}

export function syncFromSheet2ToDb(): { imported: number } {
  console.log('从POPO Sheet2同步数据...');
  const { cells, rowCount, colCount } = readSheet1Data();

  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headers.push(String(cells[`0,${c}`] || ''));
  }

  const colIdx: Record<string, number> = {};
  headers.forEach((h, i) => { if (h) colIdx[h] = i; });

  const records: (Omit<EpcPayment, 'updated_at'> & { submitter?: string })[] = [];

  for (let r = 1; r < rowCount; r++) {
    const internalOrderNo = String(cells[`${r},${colIdx['epc单号'] || 0}`] || '').trim();
    const payeeName = String(cells[`${r},${colIdx['姓名'] || 1}`] || '').trim();
    const payeePhone = String(cells[`${r},${colIdx['手机号'] || 2}`] || '').trim();

    if (!internalOrderNo) continue;

    const amountStr = String(cells[`${r},${colIdx['金额'] || 3}`] || '').replace(/[,，]/g, '');
    const actualStr = String(cells[`${r},${colIdx['实收金额'] || 4}`] || '').replace(/[,，]/g, '');
    const statusNode = String(cells[`${r},${colIdx['当前节点'] || 5}`] || '').trim();
    const statusText = String(cells[`${r},${colIdx['状态说明'] || 6}`] || '').trim();
    const paidStr = String(cells[`${r},${colIdx['是否已支付'] || 7}`] || '').trim();
    const paidTime = String(cells[`${r},${colIdx['支付时间'] || 8}`] || '').trim();

    records.push({
      internal_order_no: internalOrderNo,
      payee_name: payeeName || null,
      payee_phone: payeePhone || null,
      amount: parseFloat(amountStr) || null,
      actual_amount: parseFloat(actualStr) || null,
      status_node: statusNode || null,
      status_text: statusText || null,
      paid: paidStr === '是',
      paid_time: paidTime || null,
    });
  }

  if (records.length > 0) {
    upsertPayments(records);
    console.log(`  同步 ${records.length} 条到本地数据库`);
  }

  return { imported: records.length };
}
