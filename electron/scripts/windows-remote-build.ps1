param(
  [Parameter(Mandatory = $true)][string]$RepoPath
)

# Runs ON the Windows VM. Invoked over SSH+PowerShell from build-windows.sh
# after the source tarball has been extracted to $RepoPath. Outputs the
# unsigned NSIS installer at <RepoPath>\electron\dist\.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $RepoPath 'electron')

# Wipe prior dist with the long-path-safe pattern. Plain Remove-Item -Recurse
# fails on trees with paths >260 chars (electron-builder occasionally leaves
# deep NSIS staging dirs).
function Remove-Tree-Long([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $empty = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("wipe-" + [guid]::NewGuid()))
  try {
    & robocopy $empty.FullName $Path /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -LiteralPath $Path -Force -Recurse
  } finally {
    Remove-Item -LiteralPath $empty.FullName -Force -Recurse -ErrorAction SilentlyContinue
  }
}

$distDir = Join-Path (Get-Location) 'dist'
Remove-Tree-Long $distDir

Write-Host "[windows-remote-build] npm install ..."
& npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

Write-Host "[windows-remote-build] electron-builder --win --x64 ..."
& .\node_modules\.bin\electron-builder.cmd --win --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }

$exe = Get-ChildItem -Path $distDir -Filter '*Setup*.exe' | Select-Object -First 1
if (-not $exe) { throw "No NSIS installer found under $distDir" }

$hash = (Get-FileHash -Algorithm SHA256 -Path $exe.FullName).Hash.ToLower()
Write-Host "[windows-remote-build] built  $($exe.FullName)"
Write-Host "[windows-remote-build] sha256 $hash"
