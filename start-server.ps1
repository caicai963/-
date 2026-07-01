# EPC 查询服务 - 保活启动（崩溃自动重启）
# 双击运行即可，关闭窗口停止

Set-Location "$PSScriptRoot"

Write-Host "=== EPC 查询服务（保活模式）===" -ForegroundColor Cyan
Write-Host "按 Ctrl+C 停止`n"

$restartCount = 0
while ($true) {
    try {
        if ($restartCount -gt 0) {
            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] 第 $restartCount 次重启..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
        $restartCount++
        npm run build 2>&1 | Out-Null
        node dist/query-server.js
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 服务异常: $_" -ForegroundColor Red
        Start-Sleep -Seconds 5
    }
}
