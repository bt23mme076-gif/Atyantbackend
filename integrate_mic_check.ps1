# Integration script for MicrophoneCheck component

$meetPagePath = "C:\Atyantfrontend\src\pages\MeetPage.jsx"

Write-Host "🔧 Integrating MicrophoneCheck into MeetPage.jsx..." -ForegroundColor Cyan

# Read the file
$content = Get-Content $meetPagePath -Raw

# Check if already integrated
if ($content -match "AdvancedMicrophoneCheck") {
    Write-Host "✅ MicrophoneCheck already integrated!" -ForegroundColor Green
    exit 0
}

# Backup original file
Copy-Item $meetPagePath "$meetPagePath.backup" -Force
Write-Host "📦 Backup created: MeetPage.jsx.backup" -ForegroundColor Yellow

# Add import statement after other imports
$importLine = "import AdvancedMicrophoneCheck from '../components/LiveKit/AdvancedMicrophoneCheck';"
$content = $content -replace "(import NetworkAlerts from.*\n)", "`$1$importLine`n"

# Add MicrophoneCheck to MeetTools component
$micCheckComponent = @"
            <AdvancedMicrophoneCheck />
"@

# Find the MeetTools return block and add MicrophoneCheck
$content = $content -replace "(function MeetTools.*?\{[^\}]*?return \(\s*<>)", "`$1`n$micCheckComponent"

# Save the modified content
Set-Content -Path $meetPagePath -Value $content -NoNewline

Write-Host "✅ Integration complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📝 Changes made:" -ForegroundColor Cyan
Write-Host "  1. Added import for AdvancedMicrophoneCheck"
Write-Host "  2. Added <AdvancedMicrophoneCheck /> to MeetTools"
Write-Host ""
Write-Host "🧪 Next steps:" -ForegroundColor Yellow
Write-Host "  1. Start your frontend: cd C:\Atyantfrontend && npm run dev"
Write-Host "  2. Join a test session"
Write-Host "  3. Try muting mic - should see warning"
Write-Host ""
Write-Host "⚠️  If something breaks, restore backup:" -ForegroundColor Red
Write-Host "  Copy-Item '$meetPagePath.backup' '$meetPagePath' -Force"
