$exclude = @('node_modules', 'maintenance.db', 'stderr.log', 'stdout.log', 'test-db.js', 'maintenance-management.zip', 'create_zip.ps1')
$zipName = 'maintenance-management.zip'

if (Test-Path $zipName) { Remove-Item $zipName -Force }

$items = Get-ChildItem -Path '.' | Where-Object { $exclude -notcontains $_.Name }
$items | Compress-Archive -DestinationPath $zipName -Force

if (Test-Path $zipName) {
    $size = [math]::Round((Get-Item $zipName).Length / 1MB, 2)
    Write-Host "`n[OK] Created: $zipName ($size MB)" -ForegroundColor Green
} else {
    Write-Host "`n[ERROR] Failed to create ZIP" -ForegroundColor Red
}
