# EPC 公账查询系统 - 一键安装脚本
# 以管理员身份运行
Write-Host "=== EPC 公账查询系统 安装 ===" -ForegroundColor Cyan
Write-Host "项目路径: $PSScriptRoot`n"

# 1. 安装 Node 依赖
Write-Host "[1/3] 安装 npm 依赖..." -ForegroundColor Yellow
Set-Location $PSScriptRoot
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install 失败，请确认已安装 Node.js" -ForegroundColor Red
    pause
    exit 1
}
Write-Host "  npm 依赖安装完成" -ForegroundColor Green

# 2. 安装 Playwright 浏览器
Write-Host "[2/3] 安装 Chromium 浏览器..." -ForegroundColor Yellow
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Write-Host "playwright install 失败" -ForegroundColor Red
} else {
    Write-Host "  Chromium 安装完成" -ForegroundColor Green
}

# 3. 设置每周一定时抓取任务
Write-Host "[3/3] 设置每周一自动抓取..." -ForegroundColor Yellow
$taskName = "EPC-WeeklyScrape"
$scriptDir = $PSScriptRoot
$scriptPath = Join-Path $scriptDir "run-epc.ps1"
$logPath = Join-Path $scriptDir "data" "epc-scrape.log"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$scriptPath`" >> `"$logPath`" 2>&1"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 10:30AM
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    Write-Host "  每周一 10:30 自动抓取已设置" -ForegroundColor Green
} catch {
    Write-Host "  定时任务设置失败: $_" -ForegroundColor Red
    Write-Host "  (请以管理员身份运行此脚本)" -ForegroundColor Yellow
}

Write-Host "`n=== 安装完成 ===" -ForegroundColor Cyan
Write-Host "首次使用: 运行 'npm run epc:scrape' 登录 EPC（浏览器会弹出）" -ForegroundColor White
Write-Host "启动服务: 'npm run epc:server'" -ForegroundColor White
Write-Host "访问查询: http://localhost:3000" -ForegroundColor White
Write-Host ""
Write-Host "如需修改定时时间，在 Windows 任务计划程序中编辑 'EPC-WeeklyScrape'" -ForegroundColor Gray
pause
