import { request as httpsRequest } from 'https';

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  spreadsheetToken: string;
  sheetId: string;
  range?: string;
}

function httpPost(url: string, body: object, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    };

    const req = httpsRequest(options, (res) => {
      let responseData = '';
      res.on('data', (chunk: Buffer) => (responseData += chunk.toString()));
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error(`解析响应失败: ${responseData}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url: string, headers?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers || {},
    };

    const req = httpsRequest(options, (res) => {
      let responseData = '';
      res.on('data', (chunk: Buffer) => (responseData += chunk.toString()));
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error(`解析响应失败: ${responseData}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function getTenantAccessToken(config: FeishuConfig): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const result = await httpPost(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: config.appId, app_secret: config.appSecret }
  );

  if (result.code !== 0) {
    throw new Error(`飞书认证失败: ${result.msg} (code: ${result.code})`);
  }

  tokenCache = {
    token: result.tenant_access_token,
    expiresAt: Date.now() + (result.expire - 60) * 1000,
  };

  return tokenCache.token;
}

export interface SheetRow {
  [key: string]: string | number | undefined;
}

function httpGetRaw(url: string, headers?: Record<string, string>): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*',
        ...headers,
      },
    };

    const req = httpsRequest(options, (res) => {
      let responseData = '';
      res.on('data', (chunk: Buffer) => (responseData += chunk.toString()));
      res.on('end', () => resolve({ body: responseData, statusCode: res.statusCode || 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function readSheetByShareLink(shareUrl: string, sheetName?: string): Promise<SheetRow[]> {
  const urlObj = new URL(shareUrl);
  const domain = urlObj.hostname;

  const tokenMatch = shareUrl.match(/\/sheets\/([a-zA-Z0-9_-]+)/);
  if (!tokenMatch) {
    throw new Error('无法从分享链接中解析表格token');
  }
  const spreadsheetToken = tokenMatch[1];

  const sheetId = sheetName || urlObj.searchParams.get('sheet') || '';

  const range = sheetId ? `${sheetId}!A1:ZZ10000` : 'A1:ZZ10000';
  const apiUrl = `https://${domain}/sheets/${spreadsheetToken}/api/v2/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`;

  const response = await httpGetRaw(apiUrl);

  if (response.statusCode !== 200) {
    if (response.statusCode === 403 || response.statusCode === 401) {
      throw new Error(
        '分享链接无法访问，请确保表格已设置为「获得链接的人可查看」'
      );
    }
    throw new Error(`读取分享表格失败 (HTTP ${response.statusCode}): ${response.body.substring(0, 200)}`);
  }

  let result: any;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new Error(`解析飞书响应失败: ${response.body.substring(0, 200)}`);
  }

  if (result.code !== 0) {
    throw new Error(`飞书分享链接读取失败: ${result.msg || '未知错误'} (code: ${result.code})`);
  }

  const rows = result.data?.valueRange?.values || result.data?.values;
  if (!rows || rows.length === 0) {
    return [];
  }

  const headers = rows[0] as string[];
  const data: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as (string | number | undefined)[];
    const record: SheetRow = {};
    for (let j = 0; j < headers.length; j++) {
      const value = row[j];
      record[headers[j]] = value !== undefined && value !== null ? value : undefined;
    }
    data.push(record);
  }

  return data;
}

export async function readSheetData(config: FeishuConfig): Promise<SheetRow[]> {
  const token = await getTenantAccessToken(config);
  const range = config.range || config.sheetId;

  const encodedRange = encodeURIComponent(range);
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${config.spreadsheetToken}/values/${encodedRange}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`;

  const result = await httpGet(url, {
    Authorization: `Bearer ${token}`,
  });

  if (result.code !== 0) {
    throw new Error(`飞书读取表格失败: ${result.msg} (code: ${result.code})`);
  }

  const rows = result.data?.valueRange?.values;
  if (!rows || rows.length === 0) {
    return [];
  }

  const headers = rows[0] as string[];
  const data: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as (string | number | undefined)[];
    const record: SheetRow = {};
    for (let j = 0; j < headers.length; j++) {
      const value = row[j];
      record[headers[j]] = value !== undefined && value !== null ? value : undefined;
    }
    data.push(record);
  }

  return data;
}

export function parseSpreadsheetFromUrl(url: string): { spreadsheetToken: string; sheetId: string } {
  const match = url.match(/\/sheets\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error('无法从URL解析spreadsheetToken，URL格式应为 https://xxx.feishu.cn/sheets/TOKEN?sheet=SHEET_ID');
  }
  const spreadsheetToken = match[1];

  const urlObj = new URL(url);
  const sheetId = urlObj.searchParams.get('sheet') || '';

  return { spreadsheetToken, sheetId };
}
