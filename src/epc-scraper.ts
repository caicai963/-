import { chromium, Browser, Page } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { upsertPayments, EpcPayment, getDb, getStats, closeDb, isTabScraped, markTabScraped, getExistingOrderNos, getPaidOrderNos, getOrderNosWithDetails } from './db';
import { appendToSheet2, writeUnmappedToSheet1 } from './popo-sync';

interface ScraperConfig {
  epc: {
    baseUrl: string;
    listUrl: string;
  };
  scraper: {
    tabs?: { selector: string; names: string[] };
    listRowSelector: string;
    listOrderNoColumn: string;
    detailEntry: {
      mode: string;
      rowClick: boolean;
      buttonSelector: string;
    };
    detail: {
      tableSelector: string;
      rowSelector: string;
      pageSize: number;
      cellMapping: Record<string, string>;
    };
    pagination: {
      nextButton: string;
    };
  };
}

const AUTH_STATE_PATH = resolve(__dirname, '..', 'data', 'epc-auth.json');

function loadConfig(): ScraperConfig {
  return JSON.parse(readFileSync(resolve(__dirname, '..', 'config', 'epc.json'), 'utf-8'));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCellText(row: any, cellSelectors: string): Promise<string> {
  const selectors = cellSelectors.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    try {
      const cell = row.locator(sel);
      if ((await cell.count()) > 0) {
        const text = (await cell.textContent())?.trim() || '';
        if (text) return text;
      }
    } catch { continue; }
  }
  return '';
}

function parsePayment(raw: Record<string, string>, internalOrderNo: string): Omit<EpcPayment, 'updated_at'> {
  const amountStr = (raw.amount || '').replace(/[,，¥￥\s]/g, '');
  const amount = parseFloat(amountStr) || null;
  const actualStr = (raw.actual_amount || raw.amount || '').replace(/[,，¥￥\s]/g, '');
  const actualAmount = parseFloat(actualStr) || null;

  const statusText = (raw.status_node || raw.status_text || '').toLowerCase();
  const paidKeywords = ['已支付', '已打款', '已到账', '付款完成', '已完成', 'paid', 'success'];
  const paid = paidKeywords.some((kw) => statusText.includes(kw.toLowerCase()));

  return {
    internal_order_no: internalOrderNo,
    payee_name: raw.payee_name || null,
    payee_phone: raw.payee_phone || null,
    amount,
    actual_amount: actualAmount,
    status_node: raw.status_node || null,
    status_text: raw.status_text || raw.status_node || null,
    paid,
    paid_time: raw.paid_time || null,
  };
}

async function scrapePlayerTable(
  page: Page,
  internalOrderNo: string,
  config: ScraperConfig
): Promise<Omit<EpcPayment, 'updated_at'>[]> {
  const FIELD_MAP: Record<string, string> = {
    '真实姓名': 'payee_name', '姓名': 'payee_name', '玩家': 'payee_name',
    '联系方式': 'payee_phone', '手机号': 'payee_phone', '电话': 'payee_phone',
    '礼金金额': 'amount', '礼金金额（元）': 'amount', '玩家实收': 'actual_amount', '实收金额': 'actual_amount', '玩家实收（元）': 'actual_amount',
    '当前节点': 'status_node', '状态': 'status_node',
    '支付时间': 'paid_time', '打款时间': 'paid_time',
  };
  const PLAYER_SIGNATURES = ['真实姓名', '联系方式', '礼金金额'];

  for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.evaluate(`(() => {
      const containers = document.querySelectorAll('.ant-table-body, .el-table__body-wrapper, [class*=scroll]');
      containers.forEach((c) => { c.scrollTop = c.scrollHeight; });
    })()`);
    await sleep(1500);
  }
  await sleep(500);

  const tableSelectors = ['.ant-table', '.el-table', 'table', '[class*=detail] table', '[class*=player]'];
  let colMap: Record<string, number> | null = null;
  let targetTableLocator: any = null;

  console.log(`  [表格探测] 开始扫描详情页表格...`);
  for (const tableSel of tableSelectors) {
    const tables = page.locator(tableSel);
    const tc = await tables.count();
    if (tc === 0) continue;
    for (let t = 0; t < tc; t++) {
      const tableEl = tables.nth(t);
      const ths = tableEl.locator('.ant-table-thead th, thead th, th, [class*=header] [class*=cell]');
      const hc = await ths.count();
      if (hc === 0) continue;

      const texts: string[] = [];
      for (let c = 0; c < hc; c++) {
        texts.push((await ths.nth(c).textContent())?.trim()?.replace(/\s+/g, '') || '');
      }
      console.log(`    [表${t}] ${tableSel} 列: [${texts.join(' | ')}]`);

      const playerHits = texts.filter((t) => PLAYER_SIGNATURES.some((sig) => t.includes(sig)));
      if (playerHits.length < 2) continue;

      for (let c = 0; c < texts.length; c++) {
        for (const [key, field] of Object.entries(FIELD_MAP)) {
          if (texts[c].includes(key)) {
            if (!colMap) colMap = {};
            if (!colMap[field]) {
              colMap[field] = c;
              console.log(`    列${c}="${texts[c]}" -> ${field}`);
            }
          }
        }
      }
      if (colMap) {
        targetTableLocator = tableEl;
        break;
      }
    }
    if (colMap) break;
  }

  if (!colMap || !targetTableLocator) {
    console.log(`  未找到玩家明细表`);
    return [];
  }

  const result: Omit<EpcPayment, 'updated_at'>[] = [];
  const targetTable = targetTableLocator;
  let detailPage = 1;

  while (true) {
    console.log(`  明细第${detailPage}页...`);
    await sleep(1000);

    const rows = targetTable.locator('tbody tr, .ant-table-tbody tr, [class*=body] tr');
    const rc = await rows.count();
    console.log(`    ${rc} 行`);

    for (let r = 0; r < rc; r++) {
      const row = rows.nth(r);
      const raw: Record<string, string> = {};
      for (const [field, col] of Object.entries(colMap as Record<string, number>)) {
        raw[field] = (await row.locator(`td:nth-child(${col + 1})`).textContent())?.trim() || '';
      }
      if (raw.payee_name || raw.payee_phone) {
        result.push(parsePayment(raw, internalOrderNo));
      }
    }

    try {
      const hasNext = await page.evaluate(`
        (function() {
          var next = document.querySelector('li.ant-pagination-next:not(.ant-pagination-disabled)');
          if (next && next.getAttribute('aria-disabled') !== 'true') { next.click(); return true; }
          var all = document.querySelectorAll('[class*=next]:not([class*=disabled]):not([class*=is-disabled])');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled')) {
              el.click();
              return true;
            }
          }
          return false;
        })()
      `);
      if (hasNext) { detailPage++; await sleep(2500); }
      else break;
    } catch { break; }
  }

  if (result.length > 0) {
    const first = result[0];
    console.log(`    [首条样本] 姓名=${first.payee_name} 手机=${first.payee_phone} 金额=${first.amount} 实收=${first.actual_amount} 节点=${first.status_node}`);
  }

  return result;
}

async function waitForLogin(page: Page): Promise<void> {
  const config = loadConfig();
  console.log('等待SSO登录...');
  console.log('如需手动操作（扫码/验证码），请在浏览器窗口中完成，最多等5分钟\n');

  await page.goto(config.epc.listUrl, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const url = page.url();
    if (url.includes('/app/epc/') && !url.includes('login')) {
      console.log('登录成功！\n');
      await sleep(3000);
      const state = await page.context().storageState();
      const fs = require('fs');
      fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2));
      return;
    }
  }
  throw new Error('登录超时');
}

export async function runScraper(): Promise<{ count: number; stats: ReturnType<typeof getStats> }> {
  const config = loadConfig();
  console.log('=== EPC 公账数据抓取 ===');
  console.log(`开始: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`);

  const hasAuth = existsSync(AUTH_STATE_PATH);
  let browser: Browser;

  if (hasAuth) {
    console.log('尝试复用认证...');
    try {
      const state = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf-8'));
      browser = await chromium.launch({ headless: false });
      const ctx = await browser.newContext({ storageState: state });
      const pg = await ctx.newPage();
      await pg.goto(config.epc.listUrl, { waitUntil: 'networkidle', timeout: 15000 });
      if (pg.url().includes('login')) {
        console.log('认证过期，需重新登录');
        await ctx.close();
        browser = await chromium.launch({ headless: false });
        const newCtx = await browser.newContext();
        const newPg = await newCtx.newPage();
        await waitForLogin(newPg);
      } else {
        console.log('认证有效\n');
      }
    } catch {
      browser = await chromium.launch({ headless: false });
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await waitForLogin(pg);
    }
  } else {
    browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await waitForLogin(pg);
  }

  const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
  const seenOrders = new Set<string>();
  const allPayments: Omit<EpcPayment, 'updated_at'>[] = [];

  try {
    await page.goto(config.epc.listUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const tabNames: string[] = config.scraper.tabs?.names || [];
    const forceAll = process.env.EPC_FORCE_ALL === '1';
    const onceOnlyTabs = ['公司结款'];
    console.log(`标签页: ${tabNames.length > 0 ? tabNames.join(', ') : '无（直接抓取列表）'}\n`);
    const dbExistingOrders = getExistingOrderNos();
    const dbPaidOrders = getPaidOrderNos();
    const dbOrdersWithDetails = getOrderNosWithDetails();
    console.log(`数据库中已有 ${dbExistingOrders.size} 个单号（${dbPaidOrders.size} 个已结款，${dbOrdersWithDetails.size} 个已有明细）\n`);

    for (let tabIdx = 0; tabIdx < (tabNames.length || 1); tabIdx++) {
      const tabName = tabNames[tabIdx];

      if (tabName && !forceAll && onceOnlyTabs.includes(tabName) && isTabScraped(tabName)) {
        console.log(`--- 跳过标签: ${tabName}（已抓取过，无需重复。设置 EPC_FORCE_ALL=1 可强制重抓）---\n`);
        continue;
      }

      if (tabName) {
        console.log(`--- 切换到标签: ${tabName} ---`);
        if (tabIdx > 0) {
          let clicked = false;
          const strategies = [
            () => page.locator(`.el-tabs__item:has-text("${tabName}")`).first(),
            () => page.getByText(tabName).first(),
            () => page.locator(`[role="tab"]:has-text("${tabName}")`).first(),
            () => page.locator(`.el-tabs__item >> nth=${tabIdx}`),
          ];
          for (const getEl of strategies) {
            try {
              const el = getEl();
              if (await el.count() === 0) continue;
              await el.scrollIntoViewIfNeeded();
              await el.click({ force: true, timeout: 5000 });
              await sleep(3000);
              clicked = true;
              break;
            } catch { continue; }
          }
          if (clicked) {
            try {
              await page.waitForSelector(config.scraper.listRowSelector, { timeout: 10000 });
              await sleep(2000);
              console.log(`  已切换`);
            } catch {
              console.log(`  标签已切换，但无数据行`);
              await sleep(1500);
            }
          } else {
            console.log(`  切换失败，继续尝试...`);
          }
        } else {
          console.log(`  默认标签`);
        }
      }

    let listPage = 1;
    let prevPageFingerprint = '';
    const MAX_PAGES = 50;
    while (true) {
    console.log(`列表第${listPage}页...`);
    await sleep(1500);

    const listRows = page.locator(config.scraper.listRowSelector);
    const totalOrders = await listRows.count();
    console.log(`  ${totalOrders} 行\n`);

    const newBefore = seenOrders.size;
    const pageOrderNos: string[] = [];
    for (let i = 0; i < Math.min(totalOrders, 3); i++) {
      pageOrderNos.push(await getCellText(listRows.nth(i), config.scraper.listOrderNoColumn));
    }
    const pageFingerprint = pageOrderNos.filter(Boolean).join('|');
    if (listPage > 1 && pageFingerprint && pageFingerprint === prevPageFingerprint) {
      console.log(`  首页订单号与上页相同 (${pageFingerprint})，翻页无效，停止\n`);
      break;
    }
    prevPageFingerprint = pageFingerprint;

    let newOrdersOnPage = 0;
    let validRowsOnPage = 0;
    let alreadyPaidOnPage = 0;
    for (let i = 0; i < totalOrders; i++) {
      const row = listRows.nth(i);
      const orderNo = await getCellText(row, config.scraper.listOrderNoColumn);

      if (i === 0) {
        const rowHtml = await row.evaluate((el) => el.innerHTML.substring(0, 800)).catch(() => 'ERROR');
        console.log(`  [行诊断] 第${i + 1}行HTML(前800): ${rowHtml}`);
      }

      if (!orderNo) {
        console.log(`[${tabName ? tabName + ' / ' : ''}${i + 1}/${totalOrders}] 跳过（无单号）`);
        continue;
      }

      if (i === 1) {
        const lastTdHtml = await row.locator('td:last-child').evaluate((el) => el.innerHTML.substring(0, 500)).catch(() => 'ERROR');
        console.log(`  [预览按钮诊断] 第${i + 1}行操作列HTML(前500): ${lastTdHtml}`);
      }

      if (!dbExistingOrders.has(orderNo)) newOrdersOnPage++;
      validRowsOnPage++;
      if (tabName === '公司结款' && dbPaidOrders.has(orderNo)) alreadyPaidOnPage++;

      console.log(`[${tabName ? tabName + ' / ' : ''}${i + 1}/${totalOrders}] 处理: ${orderNo}`);

      let statusNode = await getCellText(row, 'td:nth-child(9)');
      let paid = (statusNode || '').includes('已支付') || (statusNode || '').includes('已打款');

      if (tabName === '公司结款') {
        statusNode = '已打款';
        paid = true;
      }

      console.log(`  列表状态: ${statusNode || '未获取'}`);

      const skipPreview = true;
      if (skipPreview) {
        if (!seenOrders.has(orderNo)) {
          seenOrders.add(orderNo);
          allPayments.push({
            internal_order_no: orderNo,
            payee_name: null,
            payee_phone: null,
            amount: null,
            actual_amount: null,
            status_node: statusNode || null,
            status_text: null,
            paid,
            paid_time: paid ? new Date().toISOString().split('T')[0] : null,
          });
        }
        continue;
      }

      const previewSelectors = [
        'button:has-text("预览")',
        'a:has-text("预览")',
        '.el-button:has-text("预览")',
        'span:has-text("预览")',
        '[class*=preview]',
      ].join(', ');
      if (previewSelectors) {
        let btn = row.locator(previewSelectors).first();
        let btnCount = await btn.count().catch(() => 0);
        if (btnCount === 0) {
          btn = row.locator('text=预览').first();
          btnCount = await btn.count().catch(() => 0);
        }
        try {
          if (btnCount > 0) {
            const preClickUrl = page.url();
            let navigated = false;
            try {
              await Promise.all([
                page.waitForNavigation({ timeout: 8000 }),
                btn.click({ force: true }),
              ]);
              navigated = true;
              console.log(`  已进入详情页 (URL: ${page.url()})`);
            } catch {
              await sleep(3000);
              console.log(`  可能为弹窗模式`);
            }
            await page.evaluate('window.scrollTo(0, 0)');
            await sleep(500);
            const players = await scrapePlayerTable(page, orderNo, config);
            if (players.length > 0) {
              allPayments.push(...players);
              console.log(`  抓到 ${players.length} 个玩家`);
            } else {
              let statusNode = await getCellText(row, 'td:nth-child(9)');
              let paid = (statusNode || '').includes('已支付') || (statusNode || '').includes('已打款');
              if (tabName === '公司结款') { statusNode = '已打款'; paid = true; }
              if (!seenOrders.has(orderNo)) {
                seenOrders.add(orderNo);
                allPayments.push({
                  internal_order_no: orderNo,
                  payee_name: null,
                  payee_phone: null,
                  amount: null,
                  actual_amount: null,
                  status_node: statusNode || null,
                  status_text: null,
                  paid,
                  paid_time: paid ? new Date().toISOString().split('T')[0] : null,
                });
              }
            }
            if (navigated) {
              try {
                await page.goBack({ timeout: 10000 });
                await page.waitForSelector(config.scraper.listRowSelector, { timeout: 10000 });
                await sleep(2000);
              } catch {
                await page.goto(config.epc.listUrl, { waitUntil: 'networkidle', timeout: 15000 });
                await sleep(2000);
              }
            } else {
              const closeBtn = page.locator('.el-dialog__close, .el-dialog__headerbtn, [aria-label=Close], [class*=close]:visible').first();
              if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await closeBtn.click();
                await sleep(1500);
              }
            }
            if (tabName && navigated) {
              try {
                const tabBtn = page.locator(`.el-tabs__item:has-text("${tabName}")`).first();
                if (await tabBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await tabBtn.click({ force: true });
                  await page.waitForSelector(config.scraper.listRowSelector, { timeout: 10000 });
                  await sleep(2000);
                }
              } catch {}
            }
            continue;
          }
        } catch (e: any) {
          console.log(`  预览点击失败: ${e.message}`);
        }
      }

      if (!seenOrders.has(orderNo)) {
        seenOrders.add(orderNo);
        allPayments.push({
          internal_order_no: orderNo,
          payee_name: null,
          payee_phone: null,
          amount: null,
          actual_amount: null,
          status_node: statusNode || null,
          status_text: null,
          paid,
          paid_time: paid ? new Date().toISOString().split('T')[0] : null,
        });
      }
    }

    if (tabName === '公司结款' && validRowsOnPage > 0 && alreadyPaidOnPage === validRowsOnPage) {
      console.log(`  本页${validRowsOnPage}个单号全部已结款，停止翻页\n`);
      break;
    }

    if (listPage > 1 && seenOrders.size === newBefore) {
      console.log(`  本页未新增任何订单，翻页无效，停止`);
      break;
    }

    if (listPage >= MAX_PAGES) {
      console.log(`  已达最大页数限制(${MAX_PAGES})，停止翻页`);
      break;
    }

    let clickedNext = false;
    let disabledReason = '';

    const totalInfo = await page.evaluate(`(() => {
      const texts = document.querySelectorAll('.ant-pagination, .ant-table-pagination');
      for (const el of texts) {
        const t = el.textContent || '';
        const m1 = t.match(/共\\s*(\\d+)\\s*条/);
        const m2 = t.match(/[Tt]otal\\s*(\\d+)/);
        const m3 = t.match(/(\\d+)\\s*total/i);
        const m = m1 || m2 || m3;
        if (m) return { total: parseInt(m[1]), text: t.substring(0, 80) };
      }
      const allText = document.body.textContent || '';
      const m4 = allText.match(/共\\s*(\\d+)\\s*条/);
      if (m4) return { total: parseInt(m4[1]), text: 'body' };
      return null;
    })()`) as { total: number; text: string } | null;

    const scrapedCount = seenOrders.size;
    if (totalInfo && scrapedCount >= totalInfo.total) {
      console.log(`  已抓取 ${scrapedCount}/${totalInfo.total} 条，全部完成`);
      break;
    }

    try {
      const nextLi = page.locator('li.ant-pagination-next').first();
      const nextState = await nextLi.evaluate((el) => ({
        cls: el.className || '',
        ariaDisabled: el.getAttribute('aria-disabled'),
        disabled: (el.className || '').includes('ant-pagination-disabled') || el.getAttribute('aria-disabled') === 'true',
      })).catch(() => ({ cls: '', ariaDisabled: null, disabled: true }));
      if (listPage <= 2) {
        console.log(`  [翻页诊断] nextLi.cls="${nextState.cls.substring(0, 80)}" aria-disabled="${nextState.ariaDisabled}" disabled=${nextState.disabled}`);
      }
      if (nextState.disabled) {
        disabledReason = `ant-pagination-next 已禁用 (class="${nextState.cls.substring(0, 60)}", aria-disabled="${nextState.ariaDisabled}")`;
      } else if (await nextLi.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextLi.locator('a, button').first().click({ force: true, timeout: 3000 }).catch(() => {
          return nextLi.click({ force: true, timeout: 3000 });
        });
        clickedNext = true;
      }
    } catch {}
    if (!clickedNext) {
      try {
        const activeItem = page.locator('li.ant-pagination-item-active, li.ant-pagination-item.active').first();
        const nextNum = activeItem.locator('xpath=following-sibling::li[contains(@class,"ant-pagination-item")][1]');
        if (await nextNum.count() > 0 && await nextNum.isVisible({ timeout: 2000 }).catch(() => false)) {
          await nextNum.locator('a').first().click({ force: true, timeout: 3000 }).catch(() => {
            return nextNum.click({ force: true, timeout: 3000 });
          });
          clickedNext = true;
        }
      } catch {}
    }
    if (clickedNext) {
      await sleep(3000);
      listPage++;
      console.log(`  已翻到第${listPage}页`);
      continue;
    }
    console.log(`  翻页结束（共${listPage}页）`);
    if (disabledReason) {
      console.log(`  [原因: ${disabledReason}]`);
    }
    break;
    }
    if (tabName && onceOnlyTabs.includes(tabName)) {
      markTabScraped(tabName);
      console.log(`  已标记"${tabName}"为已抓取，下次跳过`);
    }

    }

    const allOrderNos = [...new Set(allPayments.map(p => p.internal_order_no))];
    const unmappedOrders: string[] = [];
    const db = getDb();
    for (const orderNo of allOrderNos) {
      const mapping = db.prepare('SELECT 1 FROM order_mapping WHERE internal_order_no = ?').get(orderNo);
      if (!mapping) unmappedOrders.push(orderNo);
    }
    if (unmappedOrders.length > 0) {
      console.log(`\n发现 ${unmappedOrders.length} 个未映射单号到Sheet1提醒: ${unmappedOrders.join(', ')}`);
      try {
        writeUnmappedToSheet1(unmappedOrders);
      } catch (err: any) {
        console.log(`  写入未映射提醒失败: ${err.message}`);
      }
    }

    if (allPayments.length > 0) {
      const count = upsertPayments(allPayments);
      console.log(`写入数据库 ${count} 条记录`);

      const submitter = process.env.USERNAME || process.env.USER || '默认提交人';
      console.log(`同步到POPO共享表...`);
      try {
        appendToSheet2(allPayments, submitter);
      } catch (err: any) {
        console.log(`  POPO同步失败: ${err.message}（本地数据已保存）`);
      }
    } else {
      console.log('警告：未抓取到任何数据，请检查选择器配置');
    }
  } finally {
    await browser.close();
  }

  const stats = getStats();
  console.log(`\n数据库统计: ${stats.totalPayments} 条付款记录 | ${stats.totalMappings} 条映射 | ${stats.paidCount} 已支付`);
  closeDb();
  return { count: allPayments.length, stats };
}

if (require.main === module) {
  runScraper()
    .then((r) => { console.log(`\n完成，${r.count} 条`); process.exit(0); })
    .catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
