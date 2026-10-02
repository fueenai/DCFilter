$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $projectRoot
try {
    node scripts/check.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Checks failed' }
    $manifest = Get-Content -LiteralPath 'manifest.json' -Raw | ConvertFrom-Json
    $files = @('manifest.json','README.md','icons/icon16.png','icons/icon48.png','icons/icon128.png','popup/popup.html','popup/popup.css','popup/popup.js','popup/boot.js','src/storage.js','src/early.js','src/reading-state.js','src/reading.js','src/content.js','src/content.css','src/rules.json','src/image-worker.html','src/image-worker.js')
    $files += @('src/safety-guard.js','src/safety.css','src/safety-worker.html','src/safety-worker.js','src/safety-policy.js','THIRD-PARTY-NOTICES.md','models/clip-vit-base-patch32/asset-integrity.json')
    $files += @('src/comment-policy.js','src/bot-comments.js','src/bot-comments.css')
    $files += @('src/background.js','src/image-allowlist.js','src/release-updates.js','popup/updates.js','popup/gallery-profiles.js','popup/image-allowlist-ui.js')
    if (Test-Path -LiteralPath 'LICENSE' -PathType Leaf) { $files += 'LICENSE' }
    $assets = Get-Content -LiteralPath 'models/clip-vit-base-patch32/asset-integrity.json' -Raw | ConvertFrom-Json
    $files += @($assets.files | ForEach-Object { $_.path })
    foreach ($name in $files) {
        $resolved = [IO.Path]::GetFullPath((Join-Path $projectRoot $name))
        if (-not $resolved.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "File outside project: $name" }
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Missing file: $name" }
    }
    $distDirectory = Join-Path $projectRoot 'dist'
    New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
    $destination = Join-Path $distDirectory ('DCFilter-' + $manifest.version + '.zip')
    if (Test-Path -LiteralPath $destination) { throw "Package already exists: $destination" }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $files) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $projectRoot $name), $name) | Out-Null }
    } finally { $archive.Dispose() }
    $verify = [IO.Compression.ZipFile]::OpenRead($destination)
    try {
        if ($verify.Entries.Count -ne $files.Count) { throw 'Unexpected package entry count' }
        foreach ($entry in $verify.Entries) {
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose(); $sha.Dispose() }
            if ($actual -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot $entry.FullName)).Hash) { throw "Hash mismatch: $($entry.FullName)" }
        }
    } finally { $verify.Dispose() }
    Write-Output "Verified $($files.Count) files: $destination"
    Write-Output "Bytes: $((Get-Item -LiteralPath $destination).Length)"
    Write-Output "SHA256: $((Get-FileHash -LiteralPath $destination).Hash)"
} finally { Pop-Location }
