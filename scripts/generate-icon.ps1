param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourcePath).Path)
$bitmap = $null
$graphics = $null
try {
    if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
        throw 'Source artwork must be square and at least 256 x 256 pixels.'
    }
    $bitmap = [System.Drawing.Bitmap]::new(256, 256)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#101b24'))
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.DrawImage(
        $source, [System.Drawing.Rectangle]::new(0, 0, 256, 256),
        0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel
    )
    $bitmap.Save((Join-Path $PSScriptRoot '..\images\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    if ($null -ne $graphics) { $graphics.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    $source.Dispose()
}
