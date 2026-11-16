# Enkel lokal webbserver för Lotus Elise - Stelvio.
# Startas via "Starta spelet.bat". Kräver inget installerat utöver Windows PowerShell.
param([int]$Port = 8642, [switch]$NoBrowser)

$root = $PSScriptRoot
$prefix = "http://localhost:$Port/"
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css';
  '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg';
  '.webp'='image/webp'; '.avif'='image/avif'; '.svg'='image/svg+xml'; '.ico'='image/x-icon';
  '.gltf'='model/gltf+json'; '.bin'='application/octet-stream';
  '.kn5'='application/octet-stream'; '.ai'='application/octet-stream'; '.ini'='text/plain'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "Kunde inte starta servern på port $Port. Kör spelet redan i ett annat fönster?" -ForegroundColor Red
  Read-Host "Tryck Enter för att stänga"; exit 1
}
Write-Host ""
Write-Host "  LOTUS ELISE - STELVIO" -ForegroundColor Green
Write-Host "  Servern kör på $prefix"
Write-Host "  Stäng detta fönster för att avsluta."
Write-Host ""
if (-not $NoBrowser) { Start-Process $prefix }

$shotN = 0
while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/__shot') {
      # Används endast för automatiserade testskärmdumpar.
      $ms = New-Object System.IO.MemoryStream; $req.InputStream.CopyTo($ms)
      $txt = [Text.Encoding]::ASCII.GetString($ms.ToArray())
      $b64 = $txt.Substring($txt.IndexOf(',') + 1)
      $shotN++; $out = Join-Path $env:TEMP "lotus_shot_$shotN.png"
      [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($b64))
      Write-Host "shot -> $out"
      $res.StatusCode = 200; $res.Close(); continue
    }
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/__log') {
      $sr = New-Object IO.StreamReader($req.InputStream); Write-Host ("LOG: " + $sr.ReadToEnd())
      $res.StatusCode = 200; $res.Close(); continue
    }
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
    if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $res.StatusCode = 404; $res.Close(); continue
    }
    $fi = Get-Item -LiteralPath $file
    $lm = $fi.LastWriteTimeUtc.ToString('R')
    $ext = $fi.Extension.ToLower()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers.Add('Last-Modified', $lm)
    if ($ext -eq '.js' -or $ext -eq '.html') { $res.Headers.Add('Cache-Control', 'no-cache') }
    if ($req.Headers['If-Modified-Since'] -eq $lm) { $res.StatusCode = 304; $res.Close(); continue }
    $res.ContentLength64 = $fi.Length
    $fs = [IO.File]::OpenRead($file)
    try { $fs.CopyTo($res.OutputStream, 1048576) } finally { $fs.Close() }
    $res.Close()
  } catch {
    try { $res.Abort() } catch {}
  }
}
