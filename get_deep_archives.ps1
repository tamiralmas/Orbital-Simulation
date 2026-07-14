param(
  [int]$DelayMs = 250
)

$ErrorActionPreference = "Stop"
$Invariant = [Globalization.CultureInfo]::InvariantCulture
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputPath = Join-Path $Root "js\deep-space-archives.js"

# Horizons vector epochs are JDTDB. Convert them to real UTC instants rather
# than relabelling the numeric Julian date as Unix/UTC time.
$LeapSecondTable = @(
  @("1972-01-01T00:00:00Z", 10), @("1972-07-01T00:00:00Z", 11),
  @("1973-01-01T00:00:00Z", 12), @("1974-01-01T00:00:00Z", 13),
  @("1975-01-01T00:00:00Z", 14), @("1976-01-01T00:00:00Z", 15),
  @("1977-01-01T00:00:00Z", 16), @("1978-01-01T00:00:00Z", 17),
  @("1979-01-01T00:00:00Z", 18), @("1980-01-01T00:00:00Z", 19),
  @("1981-07-01T00:00:00Z", 20), @("1982-07-01T00:00:00Z", 21),
  @("1983-07-01T00:00:00Z", 22), @("1985-07-01T00:00:00Z", 23),
  @("1988-01-01T00:00:00Z", 24), @("1990-01-01T00:00:00Z", 25),
  @("1991-01-01T00:00:00Z", 26), @("1992-07-01T00:00:00Z", 27),
  @("1993-07-01T00:00:00Z", 28), @("1994-07-01T00:00:00Z", 29),
  @("1996-01-01T00:00:00Z", 30), @("1997-07-01T00:00:00Z", 31),
  @("1999-01-01T00:00:00Z", 32), @("2006-01-01T00:00:00Z", 33),
  @("2009-01-01T00:00:00Z", 34), @("2012-07-01T00:00:00Z", 35),
  @("2015-07-01T00:00:00Z", 36), @("2017-01-01T00:00:00Z", 37)
)

function Get-TaiMinusUtcSeconds([long]$UnixMs) {
  $Offset = $null
  foreach ($Entry in $LeapSecondTable) {
    $EffectiveMs = [DateTimeOffset]::Parse([string]$Entry[0], $Invariant,
      [Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()
    if ($UnixMs -lt $EffectiveMs) { break }
    $Offset = [int]$Entry[1]
  }
  if ($null -eq $Offset) { throw "Archive generation supports UTC conversion from 1972 onward." }
  return $Offset
}

function Get-TdbMinusTtSeconds([double]$JdTt) {
  $MeanAnomalyRad = (357.53 + 0.9856003 * ($JdTt - 2451545.0)) * [Math]::PI / 180
  return 0.001657 * [Math]::Sin($MeanAnomalyRad) +
    0.00001385 * [Math]::Sin(2 * $MeanAnomalyRad)
}

function Convert-JdTdbToUnixMsUtc([double]$JdTdb) {
  $PseudoUnixMs = ($JdTdb - 2440587.5) * 86400000
  $ApproxUtcMs = [long][Math]::Round($PseudoUnixMs - 70000)
  $TaiMinusUtc = Get-TaiMinusUtcSeconds $ApproxUtcMs
  $TdbMinusUtc = $TaiMinusUtc + 32.184 + (Get-TdbMinusTtSeconds $JdTdb)
  return [long][Math]::Round($PseudoUnixMs - $TdbMinusUtc * 1000)
}

function Convert-UnixMsUtcToJdTdb([long]$UnixMs) {
  $JdUtc = 2440587.5 + $UnixMs / 86400000.0
  $TaiMinusUtc = Get-TaiMinusUtcSeconds $UnixMs
  $JdTt = $JdUtc + ($TaiMinusUtc + 32.184) / 86400.0
  return $JdUtc + ($TaiMinusUtc + 32.184 + (Get-TdbMinusTtSeconds $JdTt)) / 86400.0
}

function Encode([string]$Value) { return [Uri]::EscapeDataString($Value) }

function Invoke-HorizonsArchive([object]$Definition, [long]$StartUtcMs, [long]$StopUtcMs) {
  $StartTdb = "JD" + (Convert-UnixMsUtcToJdTdb $StartUtcMs).ToString("F9", $Invariant)
  $StopTdb = "JD" + (Convert-UnixMsUtcToJdTdb $StopUtcMs).ToString("F9", $Invariant)
  $Query = @(
    "format=json",
    "COMMAND=$(Encode "'$($Definition.Id)'")",
    "EPHEM_TYPE=VECTORS",
    "CENTER=$(Encode "'500@10'")",
    "START_TIME=$(Encode "'$StartTdb'")",
    "STOP_TIME=$(Encode "'$StopTdb'")",
    "STEP_SIZE=$(Encode "'1 d'")",
    "REF_PLANE=$(Encode "'ECLIPTIC'")",
    "REF_SYSTEM=$(Encode "'ICRF'")",
    "VEC_TABLE=2",
    "VEC_CORR=$(Encode "'NONE'")",
    "OUT_UNITS=$(Encode "'KM-S'")",
    "CSV_FORMAT=YES",
    "OBJ_DATA=NO"
  ) -join "&"
  $Response = Invoke-RestMethod -Uri ("https://ssd.jpl.nasa.gov/api/horizons.api?" + $Query) -Method Get
  $Text = [string]$Response.result
  $A = $Text.IndexOf('$$SOE')
  $B = $Text.IndexOf('$$EOE')
  if ($A -lt 0 -or $B -le $A) {
    return [pscustomobject]@{ Rows = @(); Text = $Text }
  }
  $Rows = [Collections.Generic.List[object]]::new()
  $Block = $Text.Substring($A + 5, $B - $A - 5)
  foreach ($Line in ($Block -split "`r?`n")) {
    if ($Line -notmatch '^\s*\d') { continue }
    $Part = $Line.Split(',')
    if ($Part.Count -lt 5) { continue }
    $Jd = [double]::Parse($Part[0].Trim(), $Invariant)
    $Rows.Add(@(
      (Convert-JdTdbToUnixMsUtc $Jd),
      [Math]::Round([double]::Parse($Part[2].Trim(), $Invariant), 3),
      [Math]::Round([double]::Parse($Part[3].Trim(), $Invariant), 3),
      [Math]::Round([double]::Parse($Part[4].Trim(), $Invariant), 3)
    ))
  }
  return [pscustomobject]@{ Rows = $Rows.ToArray(); Text = $Text }
}

function Get-BoundedArchiveRows([object]$Definition) {
  $StartUtcMs = [DateTimeOffset]::Parse([string]$Definition.StartDate, $Invariant,
    [Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()
  $StopUtcMs = [DateTimeOffset]::Parse([string]$Definition.StopDate, $Invariant,
    [Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()
  # Mission definitions intentionally use public launch/end dates. Horizons
  # source kernels can begin later or end earlier, so retry five minutes inside
  # each exact boundary reported by the authoritative response. A mission such
  # as Cassini can require two retries because both endpoints cross its SPK.
  $BoundaryMarginMs = 300000
  for ($AttemptIndex = 0; $AttemptIndex -lt 3; $AttemptIndex++) {
    $Attempt = Invoke-HorizonsArchive $Definition $StartUtcMs $StopUtcMs
    if (@($Attempt.Rows).Count -ge 2) { return @($Attempt.Rows) }
    $Changed = $false
    if ($Attempt.Text -match '(?:before|prior to) A\.D\. ([0-9]{4}-[A-Z]{3}-[0-9]{2} [0-9:.]+) TDB') {
      $Boundary = [DateTimeOffset]::Parse($Matches[1], $Invariant,
        [Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()
      $NextStartUtcMs = [Math]::Max($StartUtcMs, $Boundary + $BoundaryMarginMs)
      if ($NextStartUtcMs -ne $StartUtcMs) { $StartUtcMs = $NextStartUtcMs; $Changed = $true }
    }
    if ($Attempt.Text -match 'after A\.D\. ([0-9]{4}-[A-Z]{3}-[0-9]{2} [0-9:.]+) TDB') {
      $Boundary = [DateTimeOffset]::Parse($Matches[1], $Invariant,
        [Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()
      $NextStopUtcMs = [Math]::Min($StopUtcMs, $Boundary - $BoundaryMarginMs)
      if ($NextStopUtcMs -ne $StopUtcMs) { $StopUtcMs = $NextStopUtcMs; $Changed = $true }
    }
    if ($StartUtcMs -ge $StopUtcMs -or -not $Changed) { return @() }
  }
  return @()
}

function Get-PointSegmentDistanceSquared([object]$Point, [object]$A, [object]$B) {
  $AbX = [double]$B[1] - [double]$A[1]
  $AbY = [double]$B[2] - [double]$A[2]
  $AbZ = [double]$B[3] - [double]$A[3]
  $ApX = [double]$Point[1] - [double]$A[1]
  $ApY = [double]$Point[2] - [double]$A[2]
  $ApZ = [double]$Point[3] - [double]$A[3]
  $Denominator = $AbX * $AbX + $AbY * $AbY + $AbZ * $AbZ
  $U = if ($Denominator -gt 0) {
    [Math]::Max(0.0, [Math]::Min(1.0, ($ApX * $AbX + $ApY * $AbY + $ApZ * $AbZ) / $Denominator))
  } else { 0 }
  $Dx = $ApX - $U * $AbX
  $Dy = $ApY - $U * $AbY
  $Dz = $ApZ - $U * $AbZ
  return $Dx * $Dx + $Dy * $Dy + $Dz * $Dz
}

function Compress-ArchiveRows([object[]]$Rows, [double]$ToleranceKm) {
  if ($Rows.Count -le 2) { return $Rows }
  $Keep = [bool[]]::new($Rows.Count)
  $Keep[0] = $true
  $Keep[$Rows.Count - 1] = $true
  $Stack = [Collections.Generic.Stack[object]]::new()
  $Stack.Push(@(0, ($Rows.Count - 1)))
  $ToleranceSquared = $ToleranceKm * $ToleranceKm
  while ($Stack.Count) {
    $Range = $Stack.Pop()
    $First = [int]$Range[0]
    $Last = [int]$Range[1]
    $BestIndex = -1
    $BestDistance = -1.0
    for ($Index = $First + 1; $Index -lt $Last; $Index++) {
      $Distance = Get-PointSegmentDistanceSquared ($Rows[$Index]) ($Rows[$First]) ($Rows[$Last])
      if ($Distance -gt $BestDistance) { $BestDistance = $Distance; $BestIndex = $Index }
    }
    if ($BestIndex -gt $First -and $BestDistance -gt $ToleranceSquared) {
      $Keep[$BestIndex] = $true
      $Stack.Push(@($First, $BestIndex))
      $Stack.Push(@($BestIndex, $Last))
    }
  }
  $Compressed = [Collections.Generic.List[object]]::new()
  for ($Index = 0; $Index -lt $Rows.Count; $Index++) {
    if ($Keep[$Index]) { $Compressed.Add($Rows[$Index]) }
  }
  return $Compressed.ToArray()
}

function Assert-ArchiveRows([string]$Id, [object[]]$Rows) {
  if ($Rows.Count -lt 2) { throw "Archive $Id has fewer than two samples." }
  $PreviousMs = [long]::MinValue
  foreach ($Row in $Rows) {
    if ($Row.Count -ne 4) { throw "Archive $Id has a malformed sample." }
    $AtMs = [long]$Row[0]
    if ($AtMs -le $PreviousMs) { throw "Archive $Id timestamps are not strictly increasing." }
    for ($Index = 1; $Index -lt 4; $Index++) {
      if ([double]::IsNaN([double]$Row[$Index]) -or [double]::IsInfinity([double]$Row[$Index])) {
        throw "Archive $Id has a non-finite coordinate."
      }
    }
    $PreviousMs = $AtMs
  }
}

$Definitions = @(
  # End the interstellar histories at the start of the live release window.
  # deep-space-ephemeris.js supplies the overlapping current/future segment,
  # keeping the history label honest and avoiding a second predictive path.
  [pscustomobject]@{ Id = "-23"; Name = "Pioneer 10"; StartDate = "1972-03-02"; StopDate = "2026-06-28"; ToleranceKm = 250000; Class = "HISTORY" },
  [pscustomobject]@{ Id = "-24"; Name = "Pioneer 11"; StartDate = "1973-04-06"; StopDate = "2026-06-28"; ToleranceKm = 250000; Class = "HISTORY" },
  [pscustomobject]@{ Id = "-31"; Name = "Voyager 1"; StartDate = "1977-09-05"; StopDate = "2026-06-28"; ToleranceKm = 250000; Class = "HISTORY" },
  [pscustomobject]@{ Id = "-32"; Name = "Voyager 2"; StartDate = "1977-08-20"; StopDate = "2026-06-28"; ToleranceKm = 250000; Class = "HISTORY" },
  [pscustomobject]@{ Id = "-82"; Name = "Cassini"; StartDate = "1997-10-15"; StopDate = "2017-09-16"; ToleranceKm = 50000; Class = "ARCHIVE" }
)

if (($Definitions.Id | Select-Object -Unique).Count -ne $Definitions.Count) {
  throw "Archive Horizons target IDs must be unique."
}

$Trajectories = [ordered]@{}
foreach ($Definition in $Definitions) {
  Write-Host ("Fetching {0} ({1}) at one-day source cadence..." -f $Definition.Name, $Definition.Id)
  $SourceRows = @(Get-BoundedArchiveRows $Definition)
  Assert-ArchiveRows $Definition.Id $SourceRows
  $Samples = @(Compress-ArchiveRows $SourceRows ([double]$Definition.ToleranceKm))
  Assert-ArchiveRows $Definition.Id $Samples
  $Record = [ordered]@{
    name = $Definition.Name
    targetId = $Definition.Id
    trajectoryClass = $Definition.Class
    operationalStatus = "UNVERIFIED"
    startMs = [long]$Samples[0][0]
    stopMs = [long]$Samples[$Samples.Count - 1][0]
    startUtc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Samples[0][0]).UtcDateTime.ToString("o")
    stopUtc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Samples[$Samples.Count - 1][0]).UtcDateTime.ToString("o")
    sourceStepSeconds = 86400
    sourceSampleCount = $SourceRows.Count
    continuous = $true
    simplificationToleranceKm = [double]$Definition.ToleranceKm
    cadenceLabel = "one-day Horizons source, geometry-preserving simplification"
    samples = $Samples
  }
  $Trajectories[$Definition.Id] = $Record
  Write-Host ("  {0} source rows -> {1} display vertices ({2} through {3})" -f
    $SourceRows.Count, $Samples.Count, $Record.startUtc.Substring(0, 10), $Record.stopUtc.Substring(0, 10))
  if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
}

$Payload = [ordered]@{
  schemaVersion = 1
  generatedAt = [DateTime]::UtcNow.ToString("o")
  source = "NASA/JPL Horizons release-generated vectors"
  center = "500@10 (Sun center)"
  frame = "ICRF / ecliptic J2000"
  units = "km"
  timeScale = "UTC instants converted from source JDTDB"
  interpolation = "None; display-only historical polylines"
  outOfCoverage = "Do not extrapolate or infer a current position"
  rendering = "Selected mission only; inertial Sun-centered history"
  trajectories = $Trajectories
}

$Header = @"
/* GENERATED by get_deep_archives.ps1 from NASA/JPL Horizons.
 * Do not hand-edit. Selected-only historical paths are ephemerides, not
 * telemetry or proof of current operation. Source JDTDB epochs are converted
 * to UTC instants. Samples are Sun-centered ICRF/ecliptic display vertices;
 * never extrapolate them or use them as a current spacecraft state. */
"use strict";
globalThis.MTP_DEEP_ARCHIVES =
"@
$Json = $Payload | ConvertTo-Json -Depth 9 -Compress
$null = $Json | ConvertFrom-Json
$Output = $Header + $Json + ";`n"
$TempPath = $OutputPath + ".tmp"
[IO.File]::WriteAllText($TempPath, $Output, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $TempPath -Destination $OutputPath -Force
Write-Host "Wrote $OutputPath ($($Output.Length) bytes)."
