# 兼职甄别监控 - 定时任务配置脚本
# 每天 9:00, 12:30, 18:30 自动运行

$ErrorActionPreference = "Stop"

$taskName = "PartTimeMonitor"
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "run.ps1"
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "=== 兼职甄别定时任务配置 ==="
Write-Host ""

# 删除已有任务（如果存在）
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已删除旧任务: $taskName"
}

# 创建 run.ps1 启动脚本
$runScript = @'
Set-Location "$PSScriptRoot"
node dist/index.js
'@
$runScriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "run.ps1"
Set-Content -Path $runScriptPath -Value $runScript -Encoding UTF8
Write-Host "已创建启动脚本: $runScriptPath"

# 创建任务触发器（每天3次）
$trigger1 = New-ScheduledTaskTrigger -Daily -At "09:00"
$trigger2 = New-ScheduledTaskTrigger -Daily -At "12:30"
$trigger3 = New-ScheduledTaskTrigger -Daily -At "18:30"

$action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScriptPath`"" `
    -WorkingDirectory (Split-Path $runScriptPath -Parent)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew

$task = Register-ScheduledTask -TaskName $taskName `
    -Trigger $trigger1, $trigger2, $trigger3 `
    -Action $action `
    -Settings $settings `
    -User $taskUser `
    -RunLevel Limited `
    -Force

Write-Host ""
Write-Host "定时任务配置完成!"
Write-Host "  任务名: $taskName"
Write-Host "  执行时间: 每天 09:00, 12:30, 18:30"
Write-Host "  执行脚本: $runScriptPath"
Write-Host ""
Write-Host "管理命令:"
Write-Host "  查看任务:   Get-ScheduledTask -TaskName '$taskName'"
Write-Host "  手动运行:   Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  删除任务:   Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
