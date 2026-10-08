param([string]$Path, [string]$OutFile)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  $Path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  $OutFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $t) {
    $asTask = $asTaskGeneric.MakeGenericMethod($t)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) {
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $lang = New-Object Windows.Globalization.Language("zh-Hans-CN")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  }
  if (-not $engine) {
    [System.IO.File]::WriteAllText($OutFile, "__ERR__NO_ENGINE", $utf8)
    exit 1
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $out = @()
  foreach ($line in $result.Lines) {
    $x = $null; $y = $null; $x2 = $null; $y2 = $null
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      if ($null -eq $x -or $r.X -lt $x) { $x = $r.X }
      if ($null -eq $y -or $r.Y -lt $y) { $y = $r.Y }
      if ($null -eq $x2 -or ($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
      if ($null -eq $y2 -or ($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
    }
    if ($null -eq $x) { continue }
    $out += @{ t = $line.Text; x = [int]$x; y = [int]$y; w = [int]($x2 - $x); h = [int]($y2 - $y) }
  }
  if ($out.Count -eq 0) {
    [System.IO.File]::WriteAllText($OutFile, "[]", $utf8)
  } else {
    [System.IO.File]::WriteAllText($OutFile, (ConvertTo-Json -InputObject @($out) -Compress), $utf8)
  }
} catch {
  [System.IO.File]::WriteAllText($OutFile, ("__ERR__" + $_.Exception.Message), $utf8)
  exit 1
}
