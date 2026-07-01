import { runScraper } from './epc-scraper';
import { runImport } from './import-mapping';
import { startServer } from './query-server';
import { getStats, closeDb } from './db';

async function main() {
  const args = process.argv.slice(2);
  const skipScrape = args.includes('--no-scrape');
  const port = parseInt(args.find((a) => a.startsWith('--port='))?.split('=')[1] || '') || undefined;

  console.log('========================================');
  console.log('  公账查询系统');
  console.log('========================================\n');

  console.log('[1/3] 导入单号映射...');
  const importResult = await runImport();
  console.log(`  → ${importResult.inserted} 条\n`);

  if (!skipScrape) {
    console.log('[2/3] 抓取 EPC 公账数据...');
    console.log('  浏览器将打开，首次请完成 SSO 登录\n');
    try { await runScraper(); } catch (err: any) {
      console.log(`  抓取失败: ${err.message}\n  使用已有数据启动服务...\n`);
    }
  } else {
    console.log('[2/3] 跳过抓取\n');
  }

  console.log('[3/3] 启动查询服务...');
  const stats = getStats();
  console.log(`  ${stats.totalPayments} 条付款, ${stats.totalMappings} 条映射, ${stats.paidCount} 已支付\n`);

  startServer(port);

  console.log('========================================');
  console.log('  对外暴露');
  console.log('========================================');
  console.log('  下载 ngrok: https://ngrok.com/download');
  console.log('  解压到本目录，另开终端:');
  console.log('    .\\ngrok.exe http 3000');
  console.log('  把 https://xxx.ngrok-free.app 发群里');
  console.log('========================================\n');

  closeDb();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
