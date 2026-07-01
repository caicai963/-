# EPC 查询服务 - 开机自启 + 每天9点重启（需以管理员身份运行一次）

$taskName = "EPC-QueryServer"
$scriptPath = Join-Path $PSScriptRoot "start-server.ps1"

Write-Host "设置 EPC 查询服务..." -ForegroundColor Cyan

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Minimized -ExecutionPolicy Bypass -File `"$scriptPath`""

# 触发器1: 开机启动
$triggerBoot = New-ScheduledTaskTrigger -AtStartup

# 触发器2: 每天 9:00 重启（会先停旧进程再启新进程）
$triggerDaily = New-ScheduledTaskTrigger -Daily -At 9:00AM

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggerBoot, $triggerDaily -Principal $principal -Settings $settings -Force
    Write-Host "设置成功！" -ForegroundColor Green
    Write-Host "  开机自启：已启用"
    Write-Host "  每天 9:00 自动重启：已启用"
    Write-Host ""
    Write-Host "立即启动：.\start-server.ps1" -ForegroundColor Gray
} catch {
    Write-Host "设置失败: $_" -ForegroundColor Red
    Write-Host "请以管理员身份运行此脚本"
}

pause
