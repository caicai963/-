import { readFileSync } from 'fs';
import { resolve } from 'path';
import { RecordRow } from './reader';

interface RuleDef {
  field: string;
  required: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  message: string;
}

interface CheckItem {
  id: string;
  name: string;
  weight: number;
  description: string;
  rules: RuleDef[];
}

interface OutlineConfig {
  checkItems: CheckItem[];
  passThreshold: number;
}

export interface Issue {
  itemId: string;
  itemName: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  weight: number;
}

export interface QualityResult {
  partTimeName: string;
  requirementName: string;
  status: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  issues: Issue[];
  suggestion: string;
}

let cachedOutline: OutlineConfig | null = null;

export function loadOutline(configPath?: string): OutlineConfig {
  if (cachedOutline) return cachedOutline;
  const path = configPath || resolve(__dirname, '..', 'config', 'outline.json');
  const raw = readFileSync(path, 'utf-8');
  cachedOutline = JSON.parse(raw) as OutlineConfig;
  return cachedOutline;
}

function toPlainString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) {
      return value.toFixed(0);
    }
    return String(value);
  }
  return String(value).trim();
}

function evaluateRule(record: RecordRow, item: CheckItem, rule: RuleDef): Issue | null {
  const value = record[rule.field];
  const strValue = value !== undefined && value !== null ? toPlainString(value) : '';
  const numValue = Number(value);

  if (rule.required && (!strValue || strValue === '')) {
    return {
      itemId: item.id,
      itemName: item.name,
      field: rule.field,
      message: rule.message,
      severity: 'error',
      weight: item.weight,
    };
  }

  if (!strValue && !rule.required) return null;

  if (rule.pattern) {
    const regex = new RegExp(rule.pattern);
    if (!regex.test(strValue)) {
      return {
        itemId: item.id,
        itemName: item.name,
        field: rule.field,
        message: rule.message,
        severity: 'error',
        weight: item.weight,
      };
    }
  }

  if (rule.minLength !== undefined && strValue.length < rule.minLength) {
    return {
      itemId: item.id,
      itemName: item.name,
      field: rule.field,
      message: rule.message,
      severity: 'error',
      weight: item.weight,
    };
  }

  if (rule.maxLength !== undefined && strValue.length > rule.maxLength) {
    return {
      itemId: item.id,
      itemName: item.name,
      field: rule.field,
      message: rule.message,
      severity: 'error',
      weight: item.weight,
    };
  }

  if (rule.min !== undefined && !isNaN(numValue) && numValue < rule.min) {
    return {
      itemId: item.id,
      itemName: item.name,
      field: rule.field,
      message: rule.message,
      severity: 'warning',
      weight: item.weight,
    };
  }

  if (rule.max !== undefined && !isNaN(numValue) && numValue > rule.max) {
    return {
      itemId: item.id,
      itemName: item.name,
      field: rule.field,
      message: rule.message,
      severity: 'warning',
      weight: item.weight,
    };
  }

  return null;
}

function generateSuggestion(score: number, issues: Issue[]): string {
  if (score >= 90) return '优秀，继续保持';
  if (score >= 80) return '良好，部分项可优化';
  if (score >= 60) return '一般，请注意以下问题项';
  if (score >= 40) return '较差，需重点关注';
  return '严重不达标，建议暂停该兼职人员';
}

export function checkAllRecords(
  records: RecordRow[],
  outlineConfig?: OutlineConfig
): QualityResult[] {
  const outline = outlineConfig || loadOutline();
  const maxScore = outline.checkItems.reduce((sum, item) => sum + item.weight, 0);

  return records.map((record) => {
    const allIssues: Issue[] = [];

    for (const item of outline.checkItems) {
      for (const rule of item.rules) {
        const issue = evaluateRule(record, item, rule);
        if (issue) {
          allIssues.push(issue);
        }
      }
    }

    const deductedScore = allIssues
      .filter((i) => i.severity === 'error')
      .reduce((sum, i) => sum + i.weight, 0);
    const warningDeduct = allIssues
      .filter((i) => i.severity === 'warning')
      .reduce((sum, i) => sum + i.weight * 0.3, 0);

    const totalScore = Math.max(0, maxScore - deductedScore - Math.round(warningDeduct));
    const percentage = Math.round((totalScore / maxScore) * 100);

    return {
      partTimeName: String(record['part_time_name'] || '未知'),
      requirementName: String(record['requirement_name'] || '未知'),
      status: String(record['review_status'] || '未知'),
      totalScore,
      maxScore,
      percentage,
      passed: percentage >= outline.passThreshold,
      issues: allIssues,
      suggestion: generateSuggestion(percentage, allIssues),
    };
  });
}

export function groupByRequirement(results: QualityResult[]): Map<string, QualityResult[]> {
  const map = new Map<string, QualityResult[]>();
  for (const r of results) {
    const key = r.requirementName;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}
