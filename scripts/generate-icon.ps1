$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = [System.Drawing.ColorTranslator]::FromHtml('#101b24')
$surface = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#243947'))
$accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#9ce8bd'))
$ink = [System.Drawing.SolidBrush]::new($background)
$outline = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#afc0c9'), 5)
$code = [System.Drawing.Pen]::new($accent, 7)
$code.StartCap = $code.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

try {
    $graphics.Clear($background)
    $document = [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(62, 35),
        [System.Drawing.Point]::new(151, 35),
        [System.Drawing.Point]::new(193, 77),
        [System.Drawing.Point]::new(193, 217),
        [System.Drawing.Point]::new(62, 217)
    )
    $graphics.FillPolygon($surface, $document)
    $graphics.DrawPolygon($outline, $document)
    $graphics.DrawLines($outline, [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(151, 35),
        [System.Drawing.Point]::new(151, 77),
        [System.Drawing.Point]::new(193, 77)
    ))
    $graphics.DrawLines($code, [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(105, 101),
        [System.Drawing.Point]::new(85, 123),
        [System.Drawing.Point]::new(105, 145)
    ))
    $graphics.DrawLines($code, [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(145, 101),
        [System.Drawing.Point]::new(165, 123),
        [System.Drawing.Point]::new(145, 145)
    ))
    $graphics.FillEllipse($accent, 144, 159, 78, 78)
    $graphics.FillPolygon($ink, [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(173, 179),
        [System.Drawing.Point]::new(173, 217),
        [System.Drawing.Point]::new(202, 198)
    ))
    $bitmap.Save((Join-Path $PSScriptRoot '..\images\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $surface.Dispose()
    $accent.Dispose()
    $ink.Dispose()
    $outline.Dispose()
    $code.Dispose()
}
