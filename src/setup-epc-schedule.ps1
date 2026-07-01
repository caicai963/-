# EPC 公账数据每周定时抓取 - Windows 任务计划程序
# 以管理员身份运行此脚本设置每周一定时任务

$taskName = "EPC-WeeklyScrape"
$scriptPath = Join-Path $PSScriptRoot ".." "run-epc.ps1"
$logPath = Join-Path $PSScriptRoot ".." "data" "epc-scrape.log"

Write-Host "正在设置 EPC 公账每周定时抓取任务..." -ForegroundColor Cyan

# 每周一 9:00 执行
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$scriptPath`" >> `"$logPath`" 2>&1"
$trigger1 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 10:30AM
$trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At 10:30AM
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger1, $trigger2 -Principal $principal -Settings $settings -Force
    Write-Host "定时任务设置成功！" -ForegroundColor Green
    Write-Host "  任务名称: $taskName"
    Write-Host "  执行时间: 每周一、周四 10:30"
    Write-Host "  日志文件: $logPath"
    Write-Host ""
    Write-Host "如需修改执行时间，请在 Windows 任务计划程序中编辑此任务。"
} catch {
    Write-Host "设置失败: $_" -ForegroundColor Red
    Write-Host "请以管理员身份运行此脚本。"
}
