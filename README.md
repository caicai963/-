# EPC 公账查询系统

查询 EPC 公账付款进度，支持多人协作使用。

## 安装

以**管理员身份**运行 PowerShell：

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\setup-epc.ps1
```

## 使用

| 操作 | 命令 |
|------|------|
| 启动查询服务 | `.\start-server.ps1` |
| 抓取数据 | `npm run epc:scrape` |
| 设置每周一 10:30 自动抓取 | `npm run epc:setup-schedule` |
| 设置开机自启 | `.\setup-autorun.ps1`（管理员） |

## 配置文件

`config/epc.json` — 修改 EPC 地址、POPO 文档 ID、服务端口等。

## 首次使用

1. 运行 `.\setup-epc.ps1` 安装依赖
2. 运行 `npm run epc:scrape`，浏览器弹出后**登录你的 EPC 账号**
3. 运行 `.\start-server.ps1` 启动查询服务
4. 浏览器访问 `http://localhost:3000`
