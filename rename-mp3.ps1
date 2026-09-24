param(
    [switch]$Apply
)

$root = "C:\Users\xx004\Documents\ChatGPT\music\assets"
$invalid = [System.IO.Path]::GetInvalidFileNameChars()
$plan = @()

Get-ChildItem -Path $root -Directory | Sort-Object Name | ForEach-Object {
    $dir = $_.FullName
    $lrc = Get-ChildItem -Path $dir -Filter *.lrc -File | Select-Object -First 1
    $mp3List = @(Get-ChildItem -Path $dir -Filter *.mp3 -File)

    if (-not $lrc) {
        $plan += "[SKIP] $($_.Name) : no lrc found"
        return
    }
    if ($mp3List.Count -eq 0) {
        $plan += "[SKIP] $($_.Name) : no mp3 found"
        return
    }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($lrc.Name)
    $clean = $base
    foreach ($c in $invalid) { $clean = $clean.Replace([string]$c, "_") }
    $clean = $clean.Trim().TrimEnd('.')
    $newName = $clean + ".mp3"

    foreach ($mp3 in $mp3List) {
        if ($mp3.Name -eq $newName) {
            $plan += "[SAME] $($_.Name) : $($mp3.Name)"
            continue
        }
        $target = Join-Path $dir $newName
        if (Test-Path -LiteralPath $target) {
            $plan += "[CONFLICT] $($_.Name) : $($mp3.Name) -> $newName (target exists)"
            continue
        }
        if ($Apply) {
            Rename-Item -LiteralPath $mp3.FullName -NewName $newName
            $plan += "[DONE] $($_.Name) : $($mp3.Name) -> $newName"
        } else {
            $plan += "[PLAN] $($_.Name) : $($mp3.Name) -> $newName"
        }
    }
}

$plan | Out-File -FilePath "C:\Users\xx004\Documents\ChatGPT\music\rename-plan.txt" -Encoding utf8
$plan
