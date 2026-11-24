# Instalador do servidor local do Tradutor de Manhwa.
#
# Roda escondido, aberto pelo ajudante (host.ps1). Baixa o llama.cpp e o
# modelo (GGUF + mmproj) e vai escrevendo o andamento em state\install.json,
# que a extensao le para mostrar a barra de progresso. Downloads interrompidos
# continuam de onde pararam (arquivo .part).
#
# -OnlyVcRuntime: so instala o runtime do Visual C++ (pede administrador).
#
# Este arquivo e so ASCII de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI.

param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Engine = 'llama',          # llama = llama.cpp + modelo de visao
  [string]$Backend = 'vulkan',
  [string]$Tag = '',
  [string]$Repo = '',
  [string]$Quant = 'Q4_K_M,Q4_0,Q8_0',
  [switch]$OnlyVcRuntime,
  [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Utf8 = New-Object System.Text.UTF8Encoding $false
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$DlDir = Join-Path $Root 'downloads'
$ConfigPath = Join-Path $Root 'config.json'
$StatePath = Join-Path $StateDir 'install.json'
$LogPath = Join-Path $LogDir 'install.log'
foreach ($d in @($StateDir, $LogDir, $DlDir)) {
  if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

$VcRedistUrl = 'https://aka.ms/vc14/vc_redist.x64.exe'

$State = [ordered]@{
  pid = $PID; finished = $false; phase = 'start'; label = ''
  step = 0; steps = 0; done = 0; total = 0
  engine = $Engine; backend = $Backend; tag = $Tag; repo = $Repo
  code = $null; error = $null; warning = $null
  startedAt = (Get-Date).ToString('o'); finishedAt = $null
}

function Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $text
  [IO.File]::AppendAllText($LogPath, $line + "`r`n", $Utf8)
  if ($Wait) { Write-Host $text }
}

# Grava JSON trocando o arquivo de uma vez. Se o ajudante estiver lendo o arquivo
# naquele instante, a troca falha ("arquivo ja existente"): tenta de novo.
function Write-JsonAtomic([string]$path, [string]$json) {
  $tmp = "$path.tmp"
  for ($i = 0; ; $i++) {
    try {
      [IO.File]::WriteAllText($tmp, $json, $Utf8)
      if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
      return
    } catch {
      if ($i -ge 20) { throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

# O andamento e so informativo: um erro aqui nunca pode derrubar o download.
function Save-State {
  try { Write-JsonAtomic $StatePath (ConvertTo-Json -InputObject $State -Depth 5) } catch { }
}

function Read-Config {
  if (Test-Path -LiteralPath $ConfigPath) {
    try { return ([IO.File]::ReadAllText($ConfigPath, $Utf8) | ConvertFrom-Json) } catch { }
  }
  return $null
}

# config.json: { engines: { llama: { runtime, model } } }
function Save-Config($runtime, $model) {
  $cfg = Read-Config
  $engines = [ordered]@{}
  if ($cfg -and $cfg.engines) { foreach ($p in $cfg.engines.PSObject.Properties) { $engines[$p.Name] = $p.Value } }
  $cur = $engines[$Engine]
  $engines[$Engine] = [ordered]@{
    runtime = if ($runtime) { $runtime } elseif ($cur) { $cur.runtime } else { $null }
    model = if ($model) { $model } elseif ($cur) { $cur.model } else { $null }
  }
  $out = [ordered]@{ engines = $engines; updatedAt = (Get-Date).ToString('o') }
  Write-JsonAtomic $ConfigPath (ConvertTo-Json -InputObject $out -Depth 5)
}

class InstallError : System.Exception {
  [string]$Code
  InstallError([string]$code, [string]$message) : base($message) { $this.Code = $code }
}

function Stop-With([string]$code, [string]$message) { throw [InstallError]::new($code, $message) }

# ---------- Download com progresso e retomada ----------

$Http = New-Object System.Net.Http.HttpClient
$Http.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
$Http.DefaultRequestHeaders.UserAgent.ParseAdd('TradutorManhwa/1.0')

function Get-Json([string]$url) {
  $res = $Http.GetAsync($url).GetAwaiter().GetResult()
  try {
    if (-not $res.IsSuccessStatusCode) { Stop-With 'HTTP' ("Erro {0} ao consultar {1}" -f [int]$res.StatusCode, $url) }
    return ($res.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
  } finally { $res.Dispose() }
}

function Save-Url([string]$url, [string]$dest, [string]$label, [long]$expected = 0) {
  if ((Test-Path -LiteralPath $dest) -and ($expected -le 0 -or (Get-Item -LiteralPath $dest).Length -eq $expected)) {
    Log "ja baixado: $dest"
    return
  }
  $part = "$dest.part"
  for ($attempt = 1; ; $attempt++) {
    try {
      Save-UrlOnce $url $part $label $expected
      break
    } catch [InstallError] {
      throw
    } catch {
      if ($attempt -ge 4) { Stop-With 'NETWORK' ("Falha ao baixar {0}: {1}" -f $label, $_.Exception.Message) }
      Log ("erro baixando {0} (tentativa {1}): {2}" -f $label, $attempt, $_.Exception.Message)
      Start-Sleep -Seconds (3 * $attempt)
    }
  }
  Move-Item -Force -LiteralPath $part -Destination $dest
}

function Save-UrlOnce([string]$url, [string]$part, [string]$label, [long]$expected) {
  $have = 0L
  if (Test-Path -LiteralPath $part) { $have = (Get-Item -LiteralPath $part).Length }
  if ($expected -gt 0 -and $have -eq $expected) { return }
  if ($expected -gt 0 -and $have -gt $expected) { Remove-Item -Force -LiteralPath $part; $have = 0L }

  $req = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get), $url
  if ($have -gt 0) { $req.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue ([Nullable[long]]$have), ([Nullable[long]]$null) }
  $res = $Http.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  try {
    $status = [int]$res.StatusCode
    if ($status -eq 416) { Remove-Item -Force -LiteralPath $part; throw "faixa invalida, recomecando" }
    if ($status -eq 404) { Stop-With 'NOT_FOUND' "Arquivo nao encontrado: $url" }
    if (-not $res.IsSuccessStatusCode) { throw "HTTP $status" }
    $append = ($have -gt 0 -and $status -eq 206)
    if (-not $append) { $have = 0L }
    $len = $res.Content.Headers.ContentLength
    $total = if ($len) { $have + [long]$len } elseif ($expected -gt 0) { $expected } else { 0L }

    $State.label = $label; $State.done = $have; $State.total = $total
    Save-State
    Log ("baixando {0} ({1} bytes, retomando de {2})" -f $url, $total, $have)

    $in = $res.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $mode = if ($append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
    $out = New-Object IO.FileStream $part, $mode, ([IO.FileAccess]::Write), ([IO.FileShare]::None)
    try {
      $buf = New-Object byte[] (1024 * 1024)
      $done = $have
      $last = [DateTime]::UtcNow
      while (($r = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $r)
        $done += $r
        if (([DateTime]::UtcNow - $last).TotalMilliseconds -ge 800) {
          $State.done = $done; Save-State; $last = [DateTime]::UtcNow
        }
      }
      $State.done = $done; Save-State
    } finally {
      $out.Dispose(); $in.Dispose()
    }
    if ($total -gt 0 -and (Get-Item -LiteralPath $part).Length -ne $total) { throw "download incompleto" }
  } finally {
    $res.Dispose()
  }
}

function Expand-ZipOver([string]$zip, [string]$dest) {
  $null = New-Item -ItemType Directory -Force -Path $dest
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($e in $archive.Entries) {
      $target = [IO.Path]::GetFullPath((Join-Path $dest $e.FullName))
      if (-not $target.StartsWith([IO.Path]::GetFullPath($dest))) { continue }  # caminho malicioso no zip
      if ($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\')) { $null = New-Item -ItemType Directory -Force -Path $target; continue }
      $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
    }
  } finally { $archive.Dispose() }
}

# ---------- Runtime do Visual C++ (o llama.cpp precisa) ----------

function Test-VcRuntime {
  foreach ($n in @('vcruntime140.dll', 'msvcp140.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$n"))) { return $false }
  }
  return $true
}

function Install-VcRuntime {
  if (Test-VcRuntime) { Log 'runtime do Visual C++ ja instalado'; return }
  $State.phase = 'vc'; $State.label = 'Runtime do Visual C++'; Save-State
  $exe = Join-Path $DlDir 'vc_redist.x64.exe'
  if (Test-Path -LiteralPath $exe) { Remove-Item -Force -LiteralPath $exe }
  Save-Url $VcRedistUrl $exe 'Runtime do Visual C++'
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    Remove-Item -Force -LiteralPath $exe
    Stop-With 'BAD_SIGNATURE' 'O instalador do Visual C++ baixado nao tem a assinatura da Microsoft.'
  }
  Log 'abrindo o instalador do Visual C++ (pede administrador)'
  try {
    $p = Start-Process -FilePath $exe -ArgumentList '/install', '/passive', '/norestart' -Verb RunAs -Wait -PassThru
  } catch {
    Stop-With 'VC_DENIED' 'O Windows nao deixou instalar o runtime do Visual C++ (permissao de administrador negada).'
  }
  # 0 = ok, 3010 = ok mas pede reiniciar, 1638 = versao mais nova ja instalada
  if ($p.ExitCode -notin @(0, 3010, 1638)) { Stop-With 'VC_FAILED' "O instalador do Visual C++ falhou (codigo $($p.ExitCode))." }
  Remove-Item -Force -LiteralPath $exe -ErrorAction SilentlyContinue
  Log 'runtime do Visual C++ instalado'
}

# ---------- Programa de cada motor ----------

function Get-RuntimeSpec {
  switch ($Engine) {
    'llama' {
      return @{
        name = 'llama.cpp'; exe = 'llama-server.exe'
        base = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag"
        zips = switch ($Backend) {
          'cpu' { @("llama-$Tag-bin-win-cpu-x64.zip") }
          'vulkan' { @("llama-$Tag-bin-win-vulkan-x64.zip") }
          'cuda' { @("llama-$Tag-bin-win-cuda-12.4-x64.zip", 'cudart-llama-bin-win-cuda-12.4-x64.zip') }
        }
      }
    }
  }
  Stop-With 'BAD_ARGS' "Motor desconhecido: $Engine"
}

function Install-Runtime {
  $spec = Get-RuntimeSpec
  $dir = Join-Path $Root ('runtimes\{0}\{1}-{2}' -f $Engine, $Tag, $Backend)
  $exe = Join-Path $dir $spec.exe
  if (-not (Test-Path -LiteralPath $exe)) {
    $tmp = "$dir.tmp"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    foreach ($z in $spec.zips) {
      $State.phase = 'runtime'; $State.step++; Save-State
      $local = Join-Path $DlDir $z
      Save-Url "$($spec.base)/$z" $local "$($spec.name) ($z)"
      $State.phase = 'extract'; $State.label = "Descompactando $z"; Save-State
      Expand-ZipOver $local $tmp
    }
    $found = Get-ChildItem -LiteralPath $tmp -Recurse -Filter $spec.exe | Select-Object -First 1
    if (-not $found) { Stop-With 'BAD_ZIP' "O pacote do $($spec.name) veio sem o $($spec.exe)." }
    if (Test-Path -LiteralPath $dir) { Remove-Item -Recurse -Force -LiteralPath $dir }
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dir)
    Move-Item -LiteralPath $found.DirectoryName -Destination $dir
    if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
    foreach ($z in $spec.zips) { Remove-Item -Force -LiteralPath (Join-Path $DlDir $z) -ErrorAction SilentlyContinue }
  } else {
    $State.step += $spec.zips.Count
    Log "$($spec.name) $Tag-$Backend ja instalado"
  }
  Save-Config ([ordered]@{ tag = $Tag; backend = $Backend; dir = $dir; exe = $exe }) $null
  # versoes antigas deste motor (se nao estiverem em uso)
  Get-ChildItem -LiteralPath (Split-Path -Parent $dir) -Directory | Where-Object { $_.FullName -ne $dir } |
    ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
}

# ---------- Modelo ----------

function Size-Of($f) { if ($f.lfs -and $f.lfs.size) { return [long]$f.lfs.size } return [long]$f.size }

function Pick-Files {
  $tree = @(Get-Json "https://huggingface.co/api/models/$Repo/tree/main")
  $ggufs = @($tree | Where-Object { $_.type -eq 'file' -and $_.path -like '*.gguf' })
  if (-not $ggufs.Count) { Stop-With 'NO_GGUF' "O repositorio $Repo nao tem arquivos .gguf." }
  $mains = @($ggufs | Where-Object { $_.path -notmatch '(^|/)(mmproj|mtp)[-_.]' -and $_.path -notmatch '-0000[1-9]-of-' })
  $proj = @($ggufs | Where-Object { $_.path -match '(^|/)mmproj' })

  $main = $null
  foreach ($q in ($Quant -split ',')) {
    $main = $mains | Where-Object { $_.path -match ("[-_.]{0}\.gguf$" -f [regex]::Escape($q)) } | Select-Object -First 1
    if ($main) { break }
  }
  if (-not $main) { $main = $mains | Sort-Object { Size-Of $_ } | Select-Object -First 1 }
  if (-not $main) { Stop-With 'NO_GGUF' "Nao achei um arquivo de modelo em $Repo." }

  $mm = $null
  foreach ($q in @('Q8_0', 'F16', 'BF16', 'F32')) {
    $mm = $proj | Where-Object { $_.path -match ("[-_.]{0}\.gguf$" -f $q) } | Select-Object -First 1
    if ($mm) { break }
  }
  if (-not $mm) { $mm = $proj | Select-Object -First 1 }
  return @{ main = $main; mmproj = $mm }
}

function Install-Model {
  $State.phase = 'model'; $State.label = 'Procurando os arquivos do modelo'; Save-State
  $pick = Pick-Files
  $files = @($pick.main) + @(if ($pick.mmproj) { $pick.mmproj })
  $State.steps += $files.Count; Save-State

  $need = 0L
  foreach ($f in $files) { $need += Size-Of $f }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))
  if ($drive.AvailableFreeSpace -lt $need + 1GB) {
    Stop-With 'DISK' ("Falta espaco no disco: o modelo precisa de {0:N1} GB e tem {1:N1} GB livres." -f ($need / 1GB), ($drive.AvailableFreeSpace / 1GB))
  }

  $dir = Join-Path $Root ('models\{0}\{1}' -f $Engine, ($Repo -replace '/', '__'))
  $null = New-Item -ItemType Directory -Force -Path $dir
  $paths = @{}
  foreach ($f in $files) {
    $State.phase = 'model'; $State.step++; Save-State
    $name = Split-Path -Leaf $f.path
    $dest = Join-Path $dir $name
    Save-Url ("https://huggingface.co/{0}/resolve/main/{1}" -f $Repo, $f.path) $dest $name (Size-Of $f)
    $paths[$f.path] = $dest
  }
  if (-not $pick.mmproj -and $Engine -eq 'llama') { $State.warning = 'NO_VISION' }

  Save-Config $null ([ordered]@{
      repo = $Repo
      file = (Split-Path -Leaf $pick.main.path); path = $paths[$pick.main.path]
      mmproj = if ($pick.mmproj) { Split-Path -Leaf $pick.mmproj.path } else { $null }
      mmprojPath = if ($pick.mmproj) { $paths[$pick.mmproj.path] } else { $null }
      bytes = $need
    })
  # modelos anteriores (se nao estiverem em uso pelo servidor)
  Get-ChildItem -LiteralPath (Split-Path -Parent $dir) -Directory | Where-Object { $_.FullName -ne $dir } |
    ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
}

# ---------- Principal ----------

try {
  if ($OnlyVcRuntime) {
    Log 'instalando so o runtime do Visual C++'
    $State.steps = 1; $State.step = 1; Save-State
    Install-VcRuntime
  } else {
    Log "instalacao: engine=$Engine backend=$Backend tag=$Tag repo=$Repo quant=$Quant"
    $State.steps = (Get-RuntimeSpec).zips.Count
    Save-State
    Install-Runtime
    Install-Model
  }
  $State.phase = 'done'; $State.label = ''
  Log 'instalacao concluida'
} catch [InstallError] {
  $State.code = $_.Exception.Code; $State.error = $_.Exception.Message
  Log ("ERRO {0}: {1}" -f $State.code, $State.error)
} catch {
  $State.code = 'INSTALL'; $State.error = $_.Exception.Message
  Log ("ERRO: {0}`r`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
} finally {
  $State.finished = $true
  $State.finishedAt = (Get-Date).ToString('o')
  Save-State
  $Http.Dispose()
}
if ($State.error) { exit 1 }
exit 0
