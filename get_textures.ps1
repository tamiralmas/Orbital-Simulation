# =============================================================================
# Mission Trajectory Planner - get_textures.ps1
# Downloads NASA-imagery-based planet texture maps and packs them into
# js/textures-data.js as base64 data URIs, so the app can use them even when
# index.html is opened straight from disk (no canvas tainting, PNG/GIF export
# keeps working).
#
# Earth and Moon use direct, fixed-resolution NASA Scientific Visualization
# Studio products so their global maps are reproducible and never fall back to
# a low-resolution third-party copy:
#   Earth: Blue Marble (Terra/MODIS), 2048x1024 JPEG, NASA Visible Earth.
#   Moon:  LRO WAC Global Mosaic v02, stitched at 2048x1024 from NASA Moon
#          Trek's documented equirectangular WMTS tiles.
# Other planets use the Solar System Scope equirectangular pack built from NASA
# elevation/imagery data (Messenger, Viking, Cassini, etc.), CC Attribution 4.0.
# Moons & minor bodies: primary source is the Celestia project's content
# pack on GitHub (NASA/USGS-derived equirectangular maps; api.github.com is
# script-friendly - 2 listing calls, downloads via raw.githubusercontent).
# Bodies GitHub lacks fall back to the Wikimedia Commons API with slow
# pacing (~1 request / 2 s), 429 retries honoring Retry-After, and 2048px
# thumbnail downloads (Wikimedia blocks full-size originals for scripts).
# Everything that succeeds - files AND search results - is cached in
# %TEMP%\mtp_textures, so each re-run only asks for what is still missing.
#
# Usage:  right-click -> "Run with PowerShell"   (or:  powershell -File get_textures.ps1)
#         -Full2K         keep 2048px resolution for every successful source
#                         (Earth and Moon are always preserved at 2048x1024)
#         -EarthMoonOnly  replace only Earth and Moon in the existing bundle
#         -Refresh        ignore the cache and re-search/re-download everything
#         -NoPrompt       return immediately when generation finishes
# =============================================================================
param(
    [switch]$Full2K,
    [switch]$EarthMoonOnly,
    [switch]$Refresh,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$base = "https://www.solarsystemscope.com/textures/download"
$agencyTextures = [ordered]@{
    earth = @{
        file = "nasa_visible_earth_blue_marble_2048.jpg"
        url = "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57730/land_ocean_ice_2048.jpg"
        mime = "image/jpeg"
        credit = "NASA Visible Earth Blue Marble (Terra/MODIS), 2048x1024"
    }
    moon = @{
        file = "nasa_moon_trek_lro_wac_2k.jpg"
        tile = "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/2/{row}/{col}.jpg"
        mime = "image/jpeg"
        credit = "NASA Moon Trek LRO WAC Global Mosaic v02, equirectangular 2K stitch"
    }
}
$textures = [ordered]@{
    sun      = "2k_sun.jpg"
    mercury  = "2k_mercury.jpg"
    venus    = "2k_venus_atmosphere.jpg"
    earth    = "2k_earth_daymap.jpg"
    moon     = "2k_moon.jpg"
    mars     = "2k_mars.jpg"
    jupiter  = "2k_jupiter.jpg"
    saturn   = "2k_saturn.jpg"
    uranus   = "2k_uranus.jpg"
    neptune  = "2k_neptune.jpg"
    ceres    = "2k_ceres_fictional.jpg"
    haumea   = "2k_haumea_fictional.jpg"
    makemake = "2k_makemake_fictional.jpg"
    eris     = "2k_eris_fictional.jpg"
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outFile = Join-Path $root "js\textures-data.js"
$tmpDir = Join-Path $env:TEMP "mtp_textures"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
if ($Refresh) { Remove-Item (Join-Path $tmpDir "*") -Force -ErrorAction SilentlyContinue }

Add-Type -AssemblyName System.Drawing

function Resample-Jpeg([string]$inPath, [int]$w, [int]$h, [long]$quality) {
    $img = [System.Drawing.Image]::FromFile($inPath)
    try {
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $gfx.DrawImage($img, 0, 0, $w, $h)
        $gfx.Dispose()
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                 Where-Object { $_.MimeType -eq "image/jpeg" }
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, $quality)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, $codec, $ep)
        $bytes = $ms.ToArray()
        $ms.Dispose(); $bmp.Dispose()
        return $bytes
    } finally { $img.Dispose() }
}

# Runs a web operation, retrying on HTTP 429 with backoff (honors Retry-After).
function Invoke-Retry([scriptblock]$op) {
    $delays = @(15, 45)
    for ($attempt = 0; $attempt -le $delays.Length; $attempt++) {
        try { return (& $op) } catch {
            $is429 = $_.Exception.Message -match "429|too many request"
            if (-not $is429 -or $attempt -eq $delays.Length) { throw }
            $wait = $delays[$attempt]
            try {
                $ra = [int]$_.Exception.Response.Headers["Retry-After"]
                if ($ra -gt 0) { $wait = [Math]::Min($ra, 120) }
            } catch {}
            Write-Host ("[429 - waiting {0}s] " -f $wait) -ForegroundColor DarkYellow -NoNewline
            Start-Sleep -Seconds $wait
        }
    }
}

function Save-RemoteFile([string]$url, [string]$path) {
    try {
        Invoke-Retry { Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing | Out-Null }
        return
    } catch {
        # Windows PowerShell 5.1 can reject otherwise valid modern certificate
        # chains. Current Windows includes curl.exe with its own TLS backend;
        # use it as a validating fallback rather than disabling certificate
        # checks. Preserve the original error when curl is unavailable.
        $original = $_
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($null -eq $curl) { throw $original }
        & $curl.Source --fail --location --silent --show-error --output $path $url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $path)) {
            throw $original
        }
    }
}

function Get-AgencyTexture([string]$id) {
    $src = $agencyTextures[$id]
    if ($null -eq $src) { throw "No fixed agency source is configured for $id." }
    $tmp = Join-Path $tmpDir $src.file
    $cached = (Test-Path -LiteralPath $tmp) -and ((Get-Item -LiteralPath $tmp).Length -gt 10KB)
    if (-not $cached) {
        if ($src.tile) {
            $bmp = New-Object System.Drawing.Bitmap(2048, 1024)
            $gfx = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $gfx.Clear([System.Drawing.Color]::Black)
                $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                for ($row = 0; $row -lt 4; $row++) {
                    for ($col = 0; $col -lt 8; $col++) {
                        $tilePath = Join-Path $tmpDir ("moon_trek_z2_r{0}_c{1}.jpg" -f $row, $col)
                        if (-not ((Test-Path -LiteralPath $tilePath) -and ((Get-Item -LiteralPath $tilePath).Length -gt 1KB))) {
                            $tileUrl = ([string]$src.tile).Replace("{row}", [string]$row).Replace("{col}", [string]$col)
                            Save-RemoteFile $tileUrl $tilePath
                        }
                        $tileImage = [System.Drawing.Image]::FromFile($tilePath)
                        try {
                            if ($tileImage.Width -ne 256 -or $tileImage.Height -ne 256) {
                                throw "Moon Trek tile $row/$col is $($tileImage.Width)x$($tileImage.Height); expected 256x256."
                            }
                            $gfx.DrawImage($tileImage, $col * 256, $row * 256, 256, 256)
                        } finally { $tileImage.Dispose() }
                    }
                }
                $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                         Where-Object { $_.MimeType -eq "image/jpeg" }
                $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
                $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                    [System.Drawing.Imaging.Encoder]::Quality, [long]92)
                $bmp.Save($tmp, $codec, $ep)
            } finally {
                $gfx.Dispose()
                $bmp.Dispose()
            }
        } else {
            Save-RemoteFile $src.url $tmp
        }
    }

    $img = [System.Drawing.Image]::FromFile($tmp)
    try {
        if ($img.Width -ne 2048 -or $img.Height -ne 1024) {
            throw "$id agency texture is $($img.Width)x$($img.Height); expected 2048x1024."
        }
    } finally {
        $img.Dispose()
    }

    return [pscustomobject]@{
        Bytes = [System.IO.File]::ReadAllBytes($tmp)
        Mime = [string]$src.mime
        Credit = [string]$src.credit
        Cached = $cached
        File = [string]$src.file
    }
}

function Get-GeneratedHeader {
    return @"
/* Generated by get_textures.ps1 on $(Get-Date -Format s)
 * Earth: NASA Visible Earth Blue Marble (Terra/MODIS), 2048x1024.
 * Moon: NASA Moon Trek LRO WAC Global Mosaic v02, 2048x1024.
 * Other planets: Solar System Scope NASA-imagery pack, CC-BY 4.0.
 * Other moons and minor bodies: Celestia NASA/USGS pack and Wikimedia Commons mission mosaics. */
"@.Trim()
}

# Fast, reproducible upgrade path used when only the two global maps need to
# change. It preserves every other generated assignment byte-for-byte.
if ($EarthMoonOnly) {
    if (-not (Test-Path -LiteralPath $outFile)) {
        throw "EarthMoonOnly requires an existing generated bundle at $outFile."
    }
    $source = [System.IO.File]::ReadAllText($outFile)
    foreach ($id in @("earth", "moon")) {
        Write-Host ("  {0,-9} <- NASA ... " -f $id) -NoNewline
        $asset = Get-AgencyTexture $id
        $b64 = [Convert]::ToBase64String($asset.Bytes)
        $line = "globalThis.MTP_TEXTURE_DATA[`"$id`"] = `"data:$($asset.Mime);base64,$b64`";"
        $pattern = '(?m)^globalThis\.MTP_TEXTURE_DATA\["' + [regex]::Escape($id) + '"\][^\r\n]*$'
        if ([regex]::Matches($source, $pattern).Count -ne 1) {
            throw "Expected exactly one $id assignment in the existing generated bundle."
        }
        $replacement = $line
        $source = [regex]::Replace($source, $pattern,
            [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
        $tag = "ok"; if ($asset.Cached) { $tag += " (cached)" }
        Write-Host ("{0} (2048x1024, {1:n0} KB)" -f $tag, ($asset.Bytes.Length / 1KB)) -ForegroundColor Green
    }
    $header = Get-GeneratedHeader
    $source = [regex]::Replace($source, '(?s)\A/\*.*?\*/',
        [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $header }, 1)
    $tempOut = $outFile + ".tmp"
    [System.IO.File]::WriteAllText($tempOut, $source, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempOut -Destination $outFile -Force
    Write-Host ("Updated Earth and Moon in js\textures-data.js ({0:n1} MB); all other entries were preserved." -f ((Get-Item $outFile).Length / 1MB)) -ForegroundColor Green
    if (-not $NoPrompt) { Read-Host "Done. Press Enter to close" }
    return
}

Write-Host ""
Write-Host "Mission Trajectory Planner - texture fetcher" -ForegroundColor Cyan
Write-Host ("Target: {0}" -f $outFile)
Write-Host ""

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine((Get-GeneratedHeader))
[void]$sb.AppendLine('"use strict";')
[void]$sb.AppendLine("globalThis.MTP_TEXTURE_DATA = {};")

$ok = 0; $fail = 0
foreach ($id in $textures.Keys) {
    $file = $textures[$id]
    try {
        $agency = $agencyTextures[$id]
        if ($null -ne $agency) {
            Write-Host ("  {0,-9} <- NASA ... " -f $id) -NoNewline
            $asset = Get-AgencyTexture $id
            $bytes = $asset.Bytes
            $mime = $asset.Mime
            $cached = $asset.Cached
            [void]$sb.AppendLine("// " + $id + ": " + $asset.Credit)
        } else {
            $url = "$base/$file"
            $tmp = Join-Path $tmpDir $file
            Write-Host ("  {0,-9} <- {1} ... " -f $id, $file) -NoNewline
            $cached = (Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 10KB)
            if (-not $cached) {
                Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing | Out-Null
            }
            if ($Full2K) { $bytes = [System.IO.File]::ReadAllBytes($tmp) }
            else { $bytes = Resample-Jpeg $tmp 1024 512 82 }
            $mime = "image/jpeg"
        }
        $b64 = [Convert]::ToBase64String($bytes)
        [void]$sb.AppendLine("globalThis.MTP_TEXTURE_DATA[`"$id`"] = `"data:$mime;base64,$b64`";")
        $tag = "ok"; if ($cached) { $tag = "ok (cached)" }
        Write-Host ("{0} ({1:n0} KB)" -f $tag, ($bytes.Length / 1KB)) -ForegroundColor Green
        $ok++
    } catch {
        Write-Host ("FAILED - {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        $fail++
    }
}

# =============================================================================
# Moons, dwarf planets & asteroids - real mission mosaics via Wikimedia Commons
# (the canonical host of NASA/JPL/USGS/ESA/JAXA global maps, stable API).
# For each body we search Commons, keep only bitmap files with an
# equirectangular 2:1-ish aspect and >=800 px width, prefer names containing
# map/mosaic/cylindrical/global, and download the best match as a 2048px
# thumbnail (Wikimedia blocks scripted downloads of full-size originals).
# =============================================================================
$ua = @{ "User-Agent" = "MissionTrajectoryPlanner/1.4 (personal offline use)" }
$commonsBodies = @(
    @{ id = "io";        q = "Io global mosaic map Galileo Voyager" }
    @{ id = "europa";    q = "Europa global mosaic map Galileo" }
    @{ id = "ganymede";  q = "Ganymede global mosaic map" }
    @{ id = "callisto";  q = "Callisto global mosaic map" }
    @{ id = "titan";     q = "Titan global map Cassini ISS mosaic" }
    @{ id = "enceladus"; q = "Enceladus global map mosaic Cassini" }
    @{ id = "triton";    q = "Triton global color map Voyager" }
    @{ id = "phobos";    q = "Phobos global map mosaic Viking" }
    @{ id = "deimos";    q = "Deimos global map mosaic" }
    @{ id = "pluto";     q = "Pluto global color map New Horizons" }
    @{ id = "charon";    q = "Charon global map New Horizons" }
    @{ id = "ceres";     q = "Ceres global map Dawn HAMO mosaic" }      # replaces the fictional SSS map
    @{ id = "vesta";     q = "Vesta global map Dawn mosaic" }
    @{ id = "bennu";     q = "Bennu global mosaic OSIRIS-REx" }
    @{ id = "ryugu";     q = "Ryugu global map Hayabusa2 mosaic" }
    @{ id = "eros";      q = "Eros global map NEAR mosaic" }
)

# --- primary source: Celestia content pack on GitHub (NASA/USGS-derived) ---
function Get-CelestiaIndex {
    $cacheFile = Join-Path $tmpDir "celestia_index.json"
    if (-not $Refresh -and (Test-Path $cacheFile)) {
        try { return @(Get-Content $cacheFile -Raw | ConvertFrom-Json) } catch {}
    }
    $idx = @()
    foreach ($dir in @("textures/medres", "textures/lores")) {
        $u = "https://api.github.com/repos/CelestiaProject/CelestiaContent/contents/" + $dir
        try {
            $list = Invoke-Retry { Invoke-RestMethod -Uri $u -Headers $ua -TimeoutSec 30 }
            foreach ($f in $list) {
                if ($f.name -match "\.(jpg|jpeg|png)$" -and $f.download_url) {
                    $idx += [pscustomobject]@{ name = $f.name.ToLower(); url = $f.download_url; dir = $dir }
                }
            }
        } catch {
            Write-Host ("  [github listing {0} failed: {1}]" -f $dir, $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    if ($idx.Count -gt 0) { $idx | ConvertTo-Json | Set-Content $cacheFile -Encoding UTF8 }
    return $idx
}
$script:celestiaIdx = $null
function Get-CelestiaHit([string]$id) {
    if ($null -eq $script:celestiaIdx) { $script:celestiaIdx = @(Get-CelestiaIndex) }
    # exact name match only (io.jpg / io.png), medres listed before lores
    foreach ($f in $script:celestiaIdx) {
        if ($f.name -match ("^" + [regex]::Escape($id) + "\.(jpg|jpeg|png)$")) { return $f }
    }
    return $null
}

function Find-CommonsMap([string]$query) {
    # NOTE: pipe characters must be %7C-encoded - Windows PowerShell's URI
    # handling rejects raw "|" (this silently broke every search in v1.4.1).
    # iiurlwidth=2048 makes the API return a thumbnail URL we are allowed to
    # download (full-size originals get HTTP 429 for non-browser clients).
    $api = "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2" +
           "&generator=search&gsrnamespace=6&gsrlimit=30" +
           "&gsrsearch=" + [uri]::EscapeDataString($query) +
           "&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=2048"
    Start-Sleep -Milliseconds 2000    # stay well under Commons' rate limit
    try {
        $resp = Invoke-Retry { Invoke-RestMethod -Uri $api -Headers $ua -TimeoutSec 30 }
    } catch {
        if ($_.Exception.Message -match "429|too many request") { throw }   # give up on this body
        Write-Host ("[api error: {0}] " -f $_.Exception.Message) -ForegroundColor Yellow -NoNewline
        return $null
    }
    if (-not $resp.query -or -not $resp.query.pages) { return $null }
    $best = $null; $bestScore = -1
    foreach ($pg in $resp.query.pages) {
        if (-not $pg.imageinfo) { continue }
        $ii = $pg.imageinfo[0]
        # TIFF originals (most USGS maps) are fine too - the thumbnail
        # renderer serves them as JPEG.
        if ($ii.mime -ne "image/jpeg" -and $ii.mime -ne "image/png" -and $ii.mime -ne "image/tiff") { continue }
        if ($ii.mime -eq "image/tiff" -and -not $ii.thumburl) { continue }
        if ($ii.width -lt 800) { continue }
        $aspect = $ii.width / [double]$ii.height
        if ($aspect -lt 1.5 -or $aspect -gt 2.6) { continue }          # equirectangular gate
        $name = $pg.title.ToLower()
        $score = [Math]::Min($ii.width, 8192) / 1000.0
        foreach ($kw in @("map", "mosaic", "cylindrical", "global", "equirect")) {
            if ($name.Contains($kw)) { $score += 4 }
        }
        foreach ($bad in @("polar", "pole", "grid", "label", "annotat", "topo", "elevation", "dem", "altimet", "shaded", "relief")) {
            if ($name.Contains($bad)) { $score -= 6 }
        }
        if ($score -gt $bestScore) {
            $dl = $ii.url
            if ($ii.thumburl) { $dl = $ii.thumburl }
            $bestScore = $score
            $best = @{ url = $dl; title = $pg.title; w = $ii.width; h = $ii.height }
        }
    }
    return $best
}

Write-Host ""
Write-Host "Moons & minor bodies (Celestia pack via GitHub; Wikimedia Commons fallback)" -ForegroundColor Cyan
$consec429 = 0
foreach ($cb in $commonsBodies) {
    try {
        Write-Host ("  {0,-9} " -f $cb.id) -NoNewline
        $meta = Join-Path $tmpDir ($cb.id + "_commons.txt")

        # Cached from a previous run? Skip the API entirely.
        $tmp = $null; $title = $null; $dims = $null
        if (-not $Refresh) {
            $hitCache = Get-ChildItem -Path (Join-Path $tmpDir ($cb.id + "_commons.*")) -ErrorAction SilentlyContinue |
                        Where-Object { $_.Length -gt 30KB -and $_.Extension -ne ".txt" } | Select-Object -First 1
            if ($hitCache) {
                $tmp = $hitCache.FullName
                if (Test-Path $meta) {
                    $parts = (Get-Content $meta -Raw).Trim() -split '\|', 3
                    $title = $parts[0]; if ($parts.Length -gt 1) { $dims = $parts[1] }
                }
                if (-not $title) { $title = "cached Commons download" }
                Write-Host "cached... " -NoNewline
            }
        }

        # 1) Celestia content pack on GitHub (no rate limits at this scale)
        if (-not $tmp) {
            $gh = Get-CelestiaHit $cb.id
            if ($gh) {
                Write-Host "github... " -NoNewline
                $ext = ".jpg"
                if ($gh.name.ToLower().EndsWith(".png")) { $ext = ".png" }
                $tmp = Join-Path $tmpDir ($cb.id + "_commons" + $ext)
                $ghUrl = $gh.url
                Start-Sleep -Milliseconds 300
                try {
                    Invoke-Retry { Invoke-WebRequest -Uri $ghUrl -Headers $ua -OutFile $tmp -UseBasicParsing | Out-Null }
                    $title = "Celestia content pack (NASA/USGS imagery): " + $gh.name
                    Set-Content -Path $meta -Value ($title + "||" + $ghUrl) -Encoding UTF8
                } catch {
                    Write-Host ("[github: {0}] " -f $_.Exception.Message) -ForegroundColor Yellow -NoNewline
                    $tmp = $null
                }
            }
        }

        # 2) a Commons URL remembered from an earlier (rate-limited) run
        if (-not $tmp -and -not $Refresh -and (Test-Path $meta)) {
            $parts = (Get-Content $meta -Raw).Trim() -split '\|', 3
            if ($parts.Length -ge 3 -and $parts[2]) {
                Write-Host "cached url... " -NoNewline
                $title = $parts[0]; $dims = $parts[1]
                $ext = ".jpg"
                if ($parts[2].ToLower().EndsWith(".png")) { $ext = ".png" }
                $tmp = Join-Path $tmpDir ($cb.id + "_commons" + $ext)
                $u2 = $parts[2]
                Start-Sleep -Milliseconds 2000
                try { Invoke-Retry { Invoke-WebRequest -Uri $u2 -Headers $ua -OutFile $tmp -UseBasicParsing | Out-Null } }
                catch {
                    Write-Host ("[{0}] " -f $_.Exception.Message) -ForegroundColor Yellow -NoNewline
                    $tmp = $null; $title = $null; $dims = $null
                }
            }
        }

        # 3) Commons search (slow path)
        if (-not $tmp) {
            Write-Host "searching... " -NoNewline
            $hit = Find-CommonsMap $cb.q
            if (-not $hit) { $hit = Find-CommonsMap ($cb.id + " surface map equirectangular") }
            if (-not $hit) { $hit = Find-CommonsMap ($cb.id + " map") }
            if (-not $hit) {
                Write-Host "no suitable global map found (gradient fallback stays)" -ForegroundColor Yellow
                $fail++
                continue
            }
            $ext = ".jpg"
            if ($hit.url.ToLower().EndsWith(".png")) { $ext = ".png" }
            $tmp = Join-Path $tmpDir ($cb.id + "_commons" + $ext)
            $dlUrl = $hit.url
            $title = $hit.title
            $dims = "" + $hit.w + "x" + $hit.h
            # remember the pick NOW - if the download 429s, the next run
            # skips the search and goes straight to this URL
            Set-Content -Path $meta -Value ($title + "|" + $dims + "|" + $dlUrl) -Encoding UTF8
            Start-Sleep -Milliseconds 2000
            Invoke-Retry { Invoke-WebRequest -Uri $dlUrl -Headers $ua -OutFile $tmp -UseBasicParsing | Out-Null }
        }

        $bytes = $null
        if ($Full2K) { $bytes = [System.IO.File]::ReadAllBytes($tmp) }
        else { $bytes = Resample-Jpeg $tmp 1024 512 82 }
        $b64 = [Convert]::ToBase64String($bytes)
        $mime = "image/jpeg"
        if ($Full2K -and $tmp.ToLower().EndsWith(".png")) { $mime = "image/png" }
        $note = $title
        if ($dims) { $note = $title + " (" + $dims + ")" }
        [void]$sb.AppendLine("// " + $cb.id + ": " + $note)
        [void]$sb.AppendLine("globalThis.MTP_TEXTURE_DATA[`"" + $cb.id + "`"] = `"data:" + $mime + ";base64," + $b64 + "`";")
        Write-Host ("ok - {0} ({1:n0} KB)" -f $title.Replace("File:", ""), ($bytes.Length / 1KB)) -ForegroundColor Green
        $ok++
        $consec429 = 0
    } catch {
        Write-Host ("FAILED - {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        $fail++
        if ($_.Exception.Message -match "429|too many request") { $consec429++ } else { $consec429 = 0 }
        if ($consec429 -ge 3) {
            Write-Host ""
            Write-Host "  Wikimedia is rate-limiting this connection. Wait ~10 minutes and re-run;" -ForegroundColor Yellow
            Write-Host "  finished bodies and search results are cached, so each run gets shorter." -ForegroundColor Yellow
            break
        }
    }
}
Write-Host ""

if ($ok -gt 0) {
    [System.IO.File]::WriteAllText($outFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    $sz = (Get-Item $outFile).Length / 1MB
    Write-Host ""
    Write-Host ("Wrote {0} texture(s) to js\textures-data.js ({1:n1} MB)." -f $ok, $sz) -ForegroundColor Green
    Write-Host "Reload index.html - planets now render as lit, rotating textured globes."
} else {
    Write-Host ""
    Write-Host "No textures downloaded - check your internet connection and retry." -ForegroundColor Red
}
if ($fail -gt 0) { Write-Host ("{0} file(s) failed; re-run to retry just the missing ones (successes are cached; -Refresh forces a full re-download)." -f $fail) -ForegroundColor Yellow }
Write-Host ""
if (-not $NoPrompt) { Read-Host "Done. Press Enter to close" }
