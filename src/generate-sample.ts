const XLSX = require('xlsx');
const path = require('path');

const headers = [
  '需求名', '兼职人', '甄别状态', '甄别时间',
  '身份证号', '银行卡号', '手机号',
  '违规记录', '黑名单检查', '学历', '匹配度评估',
  '面试评分', '面试评语', '审批状态', '复核人', '甄别时效（天）'
];

const rows = [
  ['内容审核-小说', '张三', '已完成', '2026-05-10', '110101199001011234', '6222021234567890123', '13812345678', '无', '已检查', '本科', '匹配', 85, '沟通能力良好，对审核规则理解到位', '已审批', '李主管', 2],
  ['内容审核-小说', '李四', '进行中', '2026-05-09', '110101199102022345', '6222021234567890456', '13912345678', '无', '', '大专', '基本匹配', 70, '勉强', '待审批', '', 5],
  ['图片标注-违规', '王五', '待审核', '2026-05-11', '110101199303034567', '6222021234567891678', '13712345678', '无', '已检查', '本科', '匹配', 92, '有标注经验，识别准确率高，态度认真', '审核中', '张主管', 1],
  ['图片标注-违规', '赵六', '已完成', '2026-05-08', '110101199404045678', '', '13612345678', '', '已检查', '本科', '匹配', 78, '基础能力尚可，需要加强规则学习', '已审批', '李主管', 2],
  ['视频审核', '钱七', '未开始', '', '', '', '', '', '', '', '', '', '', '', '', '']
];

const textColumns = [4, 5, 6];

const data = [headers, ...rows];
const ws = XLSX.utils.aoa_to_sheet(data);

for (let R = 1; R <= rows.length; R++) {
  for (const C of textColumns) {
    const ref = XLSX.utils.encode_cell({ r: R, c: C });
    if (ws[ref] && typeof ws[ref].v === 'string') {
      ws[ref].t = 's';
    }
    if (ws[ref] && typeof ws[ref].v === 'number') {
      const strVal = rows[R - 1][C] as string;
      ws[ref] = { t: 's', v: strVal };
    }
  }
}

ws['!cols'] = headers.map((h, i) => {
  const widths: Record<number, number> = { 4: 20, 5: 22, 6: 13, 12: 35, 15: 14 };
  return { wch: widths[i] || (h.length + 4) };
});

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

const outPath = path.resolve(__dirname, '..', 'data', 'records.xlsx');
XLSX.writeFile(wb, outPath, { bookType: 'xlsx', type: 'file' });
console.log(`示例数据已生成: ${outPath}`);
