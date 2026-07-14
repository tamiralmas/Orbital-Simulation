# Tiny static file server for local HTML tests.
# Uses only built-in Windows components; no installs needed.
# Run: powershell -ExecutionPolicy Bypass -File serve.ps1
param([int]$Port = 5555, [switch]$NoOpen)

try {
    $Host.UI.RawUI.WindowTitle = "Local HTML test server"
} catch { }

$root = $PSScriptRoot
$rootFull = [System.IO.Path]::GetFullPath($root)
$rootPrefix = $rootFull.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar

$listener = $null
try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
} catch {
    Write-Host "Could not start on port $Port (maybe it is already running?)." -ForegroundColor Yellow
    Write-Host "Details: $($_.Exception.Message)" -ForegroundColor DarkYellow
    Write-Host "If the site is already open in your browser, you are good to go."
    if ($listener) {
        try { $listener.Close() } catch { }
    }
    if (-not $NoOpen) { Start-Process "http://localhost:$Port/" }
    exit 1
}

$script:stopRequested = $false
$script:listener = $listener
$cancelHandler = [System.ConsoleCancelEventHandler]{
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true
    $script:stopRequested = $true
    if ($script:listener -and $script:listener.IsListening) {
        $script:listener.Stop()
    }
}
[Console]::add_CancelKeyPress($cancelHandler)

$exitCode = 0

try {
    Write-Host ""
    Write-Host "  Local HTML test server is running!" -ForegroundColor Green
    Write-Host "  Open:  http://localhost:$Port/" -ForegroundColor Cyan
    Write-Host "  Keep this window open while using the site. Press Ctrl+C to stop."
    Write-Host ""

    if (-not $NoOpen) { Start-Process "http://localhost:$Port/" }

    $mime = @{
        ".html" = "text/html; charset=utf-8"
        ".js"   = "text/javascript; charset=utf-8"
        ".css"  = "text/css; charset=utf-8"
        ".json" = "application/json"
        ".webmanifest" = "application/manifest+json"
        ".wasm" = "application/wasm"
        ".svg"  = "image/svg+xml"
        ".png"  = "image/png"
        ".webp" = "image/webp"
        ".ico"  = "image/x-icon"
        ".md"   = "text/plain; charset=utf-8"
    }

    while ($listener.IsListening -and -not $script:stopRequested) {
        try {
            $ctx = $listener.GetContext()
        } catch {
            break
        }

        $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
        if ($path -eq "/") { $path = "/index.html" }
        elseif ($path.EndsWith("/")) { $path = $path + "index.html" }

        $relativePath = $path.TrimStart("/").Replace("/", [string][System.IO.Path]::DirectorySeparatorChar)
        $file = Join-Path $rootFull $relativePath
        $bytes = $null

        try {
            $full = [System.IO.Path]::GetFullPath($file)
            if (Test-Path -LiteralPath $full -PathType Container) {
                $full = Join-Path $full "index.html"
            }

            # Containment: the resolved path must sit inside the site folder.
            $insideRoot = $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
            if ($insideRoot -and (Test-Path -LiteralPath $full -PathType Leaf)) {
                $ext = [System.IO.Path]::GetExtension($full).ToLower()
                $ct = $mime[$ext]
                if (-not $ct) { $ct = "application/octet-stream" }
                $ctx.Response.ContentType = $ct
                $bytes = [System.IO.File]::ReadAllBytes($full)
            }
        } catch { }

        if ($null -eq $bytes) {
            $ctx.Response.StatusCode = 404
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 - not found")
        }

        try {
            # Always revalidate during local development.
            $ctx.Response.Headers.Add("Cache-Control", "no-cache")
            $ctx.Response.ContentLength64 = $bytes.Length
            if ($ctx.Request.HttpMethod -ne "HEAD") {
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            $ctx.Response.OutputStream.Close()
        } catch { }
    }
} finally {
    [Console]::remove_CancelKeyPress($cancelHandler)
    if ($listener) {
        try {
            if ($listener.IsListening) { $listener.Stop() }
        } catch { }
        try {
            $listener.Close()
        } catch { }
    }
    if ($script:stopRequested) {
        Write-Host ""
        Write-Host "  Local HTML test server stopped." -ForegroundColor Yellow
        $exitCode = 130
    }
}

exit $exitCode
