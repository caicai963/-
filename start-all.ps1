Set-Location "$PSScriptRoot"

$withScrape = $args[0] -eq "scrape"

Write-Host "=== EPC Start ===" -ForegroundColor Cyan

if ($withScrape) {
    Write-Host "[0/2] Scraping latest data..."
    npm run build 2>&1 | Out-Null
    node dist/epc-scraper.js
    Write-Host "  Scrape done"
}

Write-Host "[1/2] Starting server..."
npm run build 2>&1 | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", "node dist/query-server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
Write-Host "  Server started (port 3000)"

Start-Sleep -Seconds 2

if (Test-Path (Join-Path $PSScriptRoot "ngrok.exe")) {
    Write-Host "[2/2] Starting ngrok..."
    Start-Process -FilePath (Join-Path $PSScriptRoot "ngrok.exe") -ArgumentList "http 3000" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
    Write-Host "  ngrok started"
} else {
    Write-Host "[2/2] ngrok.exe not found, skip"
}

Write-Host ""
Write-Host "Done. http://localhost:3000"
Start-Sleep -Seconds 3
