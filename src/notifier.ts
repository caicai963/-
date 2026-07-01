import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { URL } from 'url';

interface WeComConfig {
  webhookUrl: string;
}

interface TextMessage {
  msgtype: 'text';
  text: { content: string };
}

interface MarkdownMessage {
  msgtype: 'markdown';
  markdown: { content: string };
}

let cachedConfig: WeComConfig | null = null;

export function loadWeComConfig(configPath?: string): WeComConfig {
  if (cachedConfig) return cachedConfig;
  const { resolve } = require('path');
  const { readFileSync } = require('fs');
  const path = configPath || resolve(__dirname, '..', 'config', 'wecom.json');
  cachedConfig = JSON.parse(readFileSync(path, 'utf-8')) as WeComConfig;
  return cachedConfig;
}

function sendRequest(webhookUrl: string, body: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = mod(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.errcode === 0) {
              resolve({ success: true, message: '发送成功' });
            } else {
              resolve({ success: false, message: `发送失败: ${result.errmsg}` });
            }
          } catch {
            resolve({ success: false, message: `解析响应失败: ${data}` });
          }
        });
      }
    );

    req.on('error', (err: Error) => {
      resolve({ success: false, message: `网络错误: ${err.message}` });
    });

    req.write(body);
    req.end();
  });
}

export async function sendTextMessage(content: string): Promise<void> {
  const config = loadWeComConfig();

  if (config.webhookUrl.includes('YOUR_WEBHOOK_KEY_HERE')) {
    console.log('[跳过发送] 请先配置企微 webhook 地址: config/wecom.json');
    console.log('--- 以下是消息内容预览 ---');
    console.log(content);
    return;
  }

  const body: TextMessage = {
    msgtype: 'text',
    text: { content: content.substring(0, 4096) },
  };

  const result = await sendRequest(config.webhookUrl, JSON.stringify(body));
  console.log(`企微推送: ${result.message}`);
}

export async function sendMarkdownMessage(content: string): Promise<void> {
  const config = loadWeComConfig();

  if (config.webhookUrl.includes('YOUR_WEBHOOK_KEY_HERE')) {
    console.log('[跳过发送] 请先配置企微 webhook 地址: config/wecom.json');
    console.log('--- 以下是消息内容预览 ---');
    console.log(content);
    return;
  }

  const body: MarkdownMessage = {
    msgtype: 'markdown',
    markdown: { content },
  };

  const result = await sendRequest(config.webhookUrl, JSON.stringify(body));
  console.log(`企微推送: ${result.message}`);
}
