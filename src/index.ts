import { resolve } from 'path';
import { readFileSync } from 'fs';
import { readExcel, readCSV, mapColumns, RecordRow } from './reader';
import { checkAllRecords, groupByRequirement, loadOutline, QualityResult, Issue } from './checker';
import { sendMarkdownMessage, sendTextMessage } from './notifier';
import { readSheetData, readSheetByShareLink, FeishuConfig } from './feishu';

interface DataMappingConfig {
  dataSource: {
    type: 'feishu' | 'feishu_share' | 'excel' | 'csv';
    feishu?: FeishuConfig;
    shareLink?: string;
    sheetName?: string;
    path?: string;
  };
  columnMapping: Record<string, string>;
}

function loadDataMapping(): DataMappingConfig {
  const configPath = resolve(__dirname, '..', 'config', 'data-mapping.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as DataMappingConfig;
}

function buildProgressReport(groups: Map<string, QualityResult[]>): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  lines.push(`## 兼职甄别监控报告`);
  lines.push(`> 检查时间：${now}`);
  lines.push(`> 共 ${groups.size} 个需求`);
  lines.push('');

  let totalRecords = 0;
  let passCount = 0;

  for (const [reqName, results] of groups) {
    totalRecords += results.length;
    passCount += results.filter((r) => r.passed).length;

    lines.push(`### 📋 ${reqName}`);
    lines.push('');

    for (const r of results) {
      const icon = r.passed ? '✅' : r.percentage >= 60 ? '⚠️' : '❌';
      const progressText = getProgressText(r.status);
      lines.push(
        `> ${icon} **${r.partTimeName}** | 进度：${progressText} | 质量：${r.percentage}分`
      );

      if (r.issues.length > 0) {
        const topIssues = r.issues.slice(0, 3);
        for (const issue of topIssues) {
          const sev = issue.severity === 'error' ? '❗' : '⚡';
          lines.push(`>   ${sev} [${issue.itemName}] ${issue.message}`);
        }
        if (r.issues.length > 3) {
          lines.push(`>   ... 还有 ${r.issues.length - 3} 项问题`);
        }
      }
      lines.push('');
    }
  }

  const passRate = totalRecords > 0 ? Math.round((passCount / totalRecords) * 100) : 0;
  lines.push('---');
  lines.push(
    `**汇总**：共 ${totalRecords} 条记录，合格 ${passCount} 条，合格率 ${passRate}%`
  );

  return lines.join('\n');
}

function buildTextReport(groups: Map<string, QualityResult[]>): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  lines.push(`【兼职甄别监控报告】${now}`);
  lines.push('');

  let totalRecords = 0;
  let passCount = 0;

  for (const [reqName, results] of groups) {
    totalRecords += results.length;
    passCount += results.filter((r) => r.passed).length;

    lines.push(`【${reqName}】`);

    for (const r of results) {
      const icon = r.passed ? '✓' : r.percentage >= 60 ? '△' : '✗';
      const progressText = getProgressText(r.status);
      lines.push(`  ${icon} ${r.partTimeName} | 进度：${progressText} | 质量：${r.percentage}分`);

      if (r.issues.length > 0) {
        const topIssues = r.issues.slice(0, 2);
        for (const issue of topIssues) {
          lines.push(`    → [${issue.itemName}] ${issue.message}`);
        }
      }
    }
    lines.push('');
  }

  const passRate = totalRecords > 0 ? Math.round((passCount / totalRecords) * 100) : 0;
  lines.push(`汇总：共${totalRecords}条，合格${passCount}条，合格率${passRate}%`);

  return lines.join('\n');
}

function getProgressText(status: string): string {
  const statusMap: Record<string, string> = {
    '已完成': '已完成',
    '完成': '已完成',
    '进行中': '进行中',
    '待审核': '待审核',
    '审核中': '审核中',
    '未开始': '未开始',
  };
  return statusMap[status] || status || '未知';
}

async function main() {
  console.log('=== 兼职甄别监控系统 ===\n');

  const mappingConfig = loadDataMapping();

  let rawData: RecordRow[];
  try {
    if (mappingConfig.dataSource.type === 'feishu') {
      if (!mappingConfig.dataSource.feishu) {
        throw new Error('飞书配置缺失，请填写 data-mapping.json 中的 feishu 配置');
      }
      const feishuConfig = mappingConfig.dataSource.feishu;
      if (feishuConfig.appId === 'YOUR_APP_ID') {
        throw new Error('请先配置飞书 App ID 和 Secret: config/data-mapping.json');
      }
      console.log('从飞书 API 读取数据...');
      rawData = await readSheetData(feishuConfig);
      console.log(`飞书读取成功，${rawData.length} 条记录`);
    } else if (mappingConfig.dataSource.type === 'feishu_share') {
      if (!mappingConfig.dataSource.shareLink) {
        throw new Error('请填写分享链接: config/data-mapping.json 中的 shareLink');
      }
      console.log('从飞书分享链接读取数据...');
      rawData = await readSheetByShareLink(
        mappingConfig.dataSource.shareLink,
        mappingConfig.dataSource.sheetName
      );
      console.log(`分享链接读取成功，${rawData.length} 条记录`);
    } else {
      const dataPath = resolve(__dirname, '..', mappingConfig.dataSource.path || './data/records.xlsx');
      if (mappingConfig.dataSource.type === 'excel') {
        rawData = readExcel(dataPath, mappingConfig.dataSource.sheetName);
      } else {
        rawData = readCSV(dataPath);
      }
    }
  } catch (err: any) {
    console.error(`读取数据失败: ${err.message}`);
    await sendTextMessage(`兼职甄别监控告警：数据读取失败 - ${err.message}`);
    return;
  }

  if (rawData.length === 0) {
    console.log('数据为空，跳过检查');
    return;
  }

  console.log(`读取到 ${rawData.length} 条记录\n`);

  const mappedData = mapColumns(rawData, mappingConfig.columnMapping);
  const results = checkAllRecords(mappedData);
  const groups = groupByRequirement(results);

  const markdownReport = buildProgressReport(groups);
  const textReport = buildTextReport(groups);

  console.log('--- 报告预览 ---');
  console.log(textReport);
  console.log('');

  await sendMarkdownMessage(markdownReport);
}

main().catch((err) => {
  console.error('运行异常:', err);
  process.exit(1);
});
