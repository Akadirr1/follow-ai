<#
.SYNOPSIS
  AI Gündem — tek seferde tüm gizli anahtarları gir, doğrula, .env'e yaz.

.DESCRIPTION
  Proje kökünde çalıştır:   npm run setup:env
  veya:                     powershell -ExecutionPolicy Bypass -File scripts/setup-env.ps1

  - Var olan .env değerlerini okur; Enter'a basarsan mevcut değer korunur.
  - Gizli değerler ekranda görünmez (SecureString). EXPO_PUBLIC_* değişkenleri
    tasarım gereği herkese açıktır; onlar düz metin sorulur ve özet ekranında
    açıkça gösterilir.
  - ANTHROPIC_API_KEY verilmişse canlı doğrulanır (GET /v1/models). -SkipVerify ile kapatılır.
  - Gemini/NVIDIA anahtarları istege baglidir: canlida Supabase Vault'tan okunur.
  - EXPO_TOKEN isteğe bağlı; -VerifyExpo verilirse `eas whoami` ile doğrulanır
    (eas-cli'yi npx ile indirir, ilk seferde yavaştır).
  - .env dosyasını yalnızca senin kullanıcın okuyabilecek şekilde kilitler (icacls).
  - .env git'e girmez (.gitignore); şablon: scripts/env.example (commit'li).

  ÖNEMLİ — Expo'da EXPO_PUBLIC_ öneki olan değişkenler uygulama paketine gömülür
  ve herkese açık olur. ANTHROPIC_API_KEY bilinçli olarak o önek OLMADAN
  tutulur: Claude çağrıları sunucu tarafında (Expo API route / küçük bir proxy)
  yapılmalıdır. Bu scripti EXPO_PUBLIC_ANTHROPIC_API_KEY yazacak şekilde
  değiştirme.

  Veri kaynağı (P1 seam) — üçü de tasarım gereği herkese açık:
    EXPO_PUBLIC_DATA_MODE        mock | supabase (varsayılan mock)
    EXPO_PUBLIC_SUPABASE_URL     proje URL'si
    EXPO_PUBLIC_SUPABASE_ANON_KEY  anon JWT (koruma RLS ile; service_role DEĞİL)

.PARAMETER SkipVerify
  Anthropic anahtarını canlı doğrulama.
.PARAMETER VerifyExpo
  EXPO_TOKEN girildiyse `eas whoami` ile doğrula.
.PARAMETER EnvPath
  Yazılacak dosya (varsayılan: <repo>/.env).
#>
[CmdletBinding()]
param(
  [switch]$SkipVerify,
  [switch]$VerifyExpo,
  [string]$EnvPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $EnvPath) { $EnvPath = Join-Path $RepoRoot '.env' }

# ---------------------------------------------------------------- tanımlar
# Sıra = sorulma sırası. secret=$false olanlar düz metin girilir ve varsayılanı vardır.
$Vars = @(
  # --- Ozet saglayicisi (P11, addendum SH) ---------------------------------
  # Ucu de sunucu tarafi: hicbiri EXPO_PUBLIC_ almaz. Canli kurulumda Gemini ve
  # NVIDIA anahtarlari Supabase Vault'tan okunur; buradakiler istege bagli yerel
  # gecersiz kilmalardir ve bos birakilabilir.
  @{ Name = 'AI_PROVIDER';       Secret = $false; Required = $false; Default = 'auto'
     Prompt = 'Ozet saglayicisi: gemini | nvidia | anthropic | auto (Enter = auto)' }
  @{ Name = 'GEMINI_API_KEY';    Secret = $true;  Required = $false
     Prompt = 'Google AI Studio anahtari (istege bagli; normalde Vault''tan gelir)' }
  @{ Name = 'GEMINI_MODEL';      Secret = $false; Required = $false; Default = 'gemini-2.5-flash'
     Prompt = 'Gemini modeli (Enter = gemini-2.5-flash)' }
  @{ Name = 'NVIDIA_API_KEY';    Secret = $true;  Required = $false
     Prompt = 'NVIDIA NIM anahtari (istege bagli; normalde Vault''tan gelir)' }
  @{ Name = 'NVIDIA_MODEL';      Secret = $false; Required = $false; Default = 'meta/llama-3.3-70b-instruct'
     Prompt = 'NVIDIA modeli (Enter = meta/llama-3.3-70b-instruct)' }
  @{ Name = 'ANTHROPIC_API_KEY'; Secret = $true;  Required = $false
     Prompt = 'Anthropic API anahtari (bu projede YOK; bos birakin)'
     Pattern = '^sk-ant-'; PatternHint = 'sk-ant- ile baslamali' }
  @{ Name = 'ANTHROPIC_MODEL';   Secret = $false; Required = $false; Default = 'claude-opus-5'
     Prompt = 'Claude modeli (Enter = claude-opus-5)' }
  @{ Name = 'EXPO_TOKEN';        Secret = $true;  Required = $false
     Prompt = 'Expo erisim token (istege bagli; EAS build/submit ve CI icin; expo.dev > Access tokens)' }

  # --- Veri kaynagi (P1 seam). Ucu de TASARIM GEREGI herkese acik: Supabase URL
  # ve anon JWT istemciye gomulmek uzere yapilmistir, koruma RLS ile saglanir.
  # Bu yuzden Secret = $false: duz metin girilir ve ozet ekraninda gorunur.
  @{ Name = 'EXPO_PUBLIC_DATA_MODE'; Secret = $false; Required = $false; Default = 'mock'
     Prompt = 'Veri kaynagi: mock | supabase (Enter = mock; supabase P6 bitene kadar calismaz)'
     Pattern = '^(mock|supabase)$'; PatternHint = 'yalnizca mock veya supabase' }
  @{ Name = 'EXPO_PUBLIC_SUPABASE_URL'; Secret = $false; Required = $false
     Default = 'https://eglxzbsrewbleqlstefd.supabase.co'
     Prompt = 'Supabase proje URL (Enter = varsayilan proje)'
     Pattern = '^https://'; PatternHint = 'https:// ile baslamali' }
  # Legacy anon JWT: verify_jwt=true olan Edge Function'lar JWT bearer bekliyor
  # (arch-001.addendum.md, F bolumu). Yeni publishable anahtar
  # (sb_publishable_FR-7VBv8Y_A6q3FlFzQfug_6u7IVEdY) Edge auth yeniden ele
  # alindiginda bunun yerini alacak.
  @{ Name = 'EXPO_PUBLIC_SUPABASE_ANON_KEY'; Secret = $false; Required = $false
     Default = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnbHh6YnNyZXdibGVxbHN0ZWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyOTQyNjYsImV4cCI6MjA4OTg3MDI2Nn0.2R19msD1ozv_feOH9by__Cm12BYSaz6F2hYE2q9JaEE'
     Prompt = 'Supabase anon JWT (Enter = varsayilan proje anahtari; herkese acik)' }
)

# ---------------------------------------------------------------- yardımcılar
function Read-EnvFile([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line -split '=', 2
    $map[$k.Trim()] = $v.Trim().Trim('"')
  }
  return $map
}

function Mask([string]$v) {
  if (-not $v) { return '(bos)' }
  if ($v.Length -le 8) { return ('*' * $v.Length) }
  return $v.Substring(0, 6) + ('*' * 6) + $v.Substring($v.Length - 4)
}

function Read-Secret([string]$prompt) {
  $sec = Read-Host -Prompt $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Test-AnthropicKey([string]$key) {
  try {
    $r = Invoke-WebRequest -Uri 'https://api.anthropic.com/v1/models?limit=1' -Method GET `
      -Headers @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } -UseBasicParsing -TimeoutSec 20
    return ($r.StatusCode -eq 200)
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) { Write-Host '   -> 401: anahtar gecersiz.' -ForegroundColor Red }
    elseif ($code -eq 403) { Write-Host '   -> 403: anahtar gecerli ama bu uc nokta icin yetkisi yok.' -ForegroundColor Yellow }
    elseif ($code) { Write-Host "   -> HTTP $code" -ForegroundColor Yellow }
    else { Write-Host "   -> ag hatasi: $($_.Exception.Message)" -ForegroundColor Yellow }
    return $false
  }
}

function Test-ExpoToken([string]$token) {
  $old = $env:EXPO_TOKEN
  try {
    $env:EXPO_TOKEN = $token
    $out = & npx --yes eas-cli@latest whoami 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "   -> Expo hesabi: $($out | Select-Object -Last 1)" -ForegroundColor Green; return $true }
    Write-Host "   -> eas whoami basarisiz: $($out | Select-Object -Last 1)" -ForegroundColor Red
    return $false
  } finally { $env:EXPO_TOKEN = $old }
}

# ---------------------------------------------------------------- akış
Write-Host ''
Write-Host 'AI Gundem - ortam kurulumu' -ForegroundColor Cyan
Write-Host "Hedef dosya: $EnvPath"
Write-Host 'Enter = mevcut degeri koru. Girdiler ekranda gorunmez.'
Write-Host ''

$existing = Read-EnvFile $EnvPath
$result   = [ordered]@{}
$problems = @()

foreach ($v in $Vars) {
  $name = $v.Name
  $cur  = $existing[$name]
  $shown = if ($v.Secret) { Mask $cur } elseif ($cur) { $cur } else { "(bos, varsayilan: $($v.Default))" }
  Write-Host "[$name]  mevcut: $shown" -ForegroundColor DarkGray

  if ($v.Secret) { $val = Read-Secret $v.Prompt } else { $val = Read-Host -Prompt $v.Prompt }
  $val = $val.Trim()

  if (-not $val) {
    if ($cur) { $val = $cur }
    elseif ($v.Default) { $val = $v.Default }
  }

  if (-not $val) {
    if ($v.Required) { $problems += "$name zorunlu ama bos birakildi." }
    Write-Host ''
    continue
  }

  if ($v.Pattern -and $val -notmatch $v.Pattern) {
    $problems += "$name bicimi beklenen gibi degil ($($v.PatternHint)). Yine de yazildi."
    Write-Host "   ! bicim uyarisi: $($v.PatternHint)" -ForegroundColor Yellow
  }

  $result[$name] = $val
  Write-Host ''
}

# ---------------------------------------------------------------- doğrulama
# Yalnizca Anthropic anahtari dogrulanir; Gemini/NVIDIA icin canli dogrulama
# yoktur (kota harcar) ve anahtarlar normalde Vault'tan gelir.
if ($result['ANTHROPIC_API_KEY'] -and -not $SkipVerify) {
  Write-Host 'ANTHROPIC_API_KEY dogrulaniyor (GET /v1/models)...'
  if (Test-AnthropicKey $result['ANTHROPIC_API_KEY']) { Write-Host '   -> OK' -ForegroundColor Green }
  else { $problems += 'ANTHROPIC_API_KEY canli dogrulamadan gecemedi (yine de yazildi).' }
}
if ($result['EXPO_TOKEN'] -and $VerifyExpo) {
  Write-Host 'EXPO_TOKEN dogrulaniyor (eas whoami)...'
  if (-not (Test-ExpoToken $result['EXPO_TOKEN'])) { $problems += 'EXPO_TOKEN dogrulanamadi (yine de yazildi).' }
}

# ---------------------------------------------------------------- yazma
$lines = @(
  '# AI Gundem - yerel gizli degerler. Bu dosya git''e girmez.',
  "# Olusturan: scripts/setup-env.ps1  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))",
  '# EXPO_PUBLIC_ onekli degiskenler uygulama paketine gomulur; API anahtarlarina bu oneki VERME.',
  ''
)
foreach ($k in $result.Keys) { $lines += "$k=$($result[$k])" }
# Var olan ama bu scriptin tanimadigi anahtarlari koru
foreach ($k in $existing.Keys) {
  if (-not $result.Contains($k) -and -not ($Vars | Where-Object { $_.Name -eq $k })) { $lines += "$k=$($existing[$k])" }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($EnvPath, (($lines -join "`n") + "`n"), $utf8NoBom)

# yalnizca bu kullanici okusun (OneDrive/NTFS'te best-effort)
try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $EnvPath /inheritance:r /grant:r "${me}:(R,W)" | Out-Null
} catch { Write-Host "   ! dosya izni daraltilamadi: $($_.Exception.Message)" -ForegroundColor Yellow }

# git guvenligi: .env izleniyor mu?
Push-Location $RepoRoot
try {
  $tracked = git ls-files -- .env
  if ($tracked) { $problems += '.env git tarafindan IZLENIYOR! `git rm --cached .env` calistir.' }
  $ignored = git check-ignore -- .env
  if (-not $ignored) { $problems += '.env .gitignore''da degil!' }
} finally { Pop-Location }

# ---------------------------------------------------------------- özet
Write-Host ''
Write-Host 'Yazilan degerler:' -ForegroundColor Cyan
foreach ($k in $result.Keys) {
  $isSecret = ($Vars | Where-Object { $_.Name -eq $k }).Secret
  $shown = if ($isSecret) { Mask $result[$k] } else { $result[$k] }
  Write-Host ("  {0,-20} {1}" -f $k, $shown)
}
if ($problems.Count) {
  Write-Host ''
  Write-Host 'Dikkat:' -ForegroundColor Yellow
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  exit 1
}
Write-Host ''
Write-Host "Tamam. $EnvPath hazir." -ForegroundColor Green
exit 0
