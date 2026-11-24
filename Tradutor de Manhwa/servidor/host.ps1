# Ajudante local do Tradutor de Manhwa (native messaging do Chrome).
#
# O Chrome abre este script (via host.bat) quando a extensao chama
# chrome.runtime.sendNativeMessage. Cada mensagem chega no stdin como JSON
# com 4 bytes de tamanho na frente; a resposta sai no stdout no mesmo formato.
# NADA alem disso pode ir para o stdout: toda saida de comando e descartada.
#
# Motores (cada um com seu programa, modelo e servidor):
#   llama = llama.cpp (llama-server) + modelo de visao GGUF   -> le e traduz
# (o OXR-1.0/CrispEmbed foi testado e retirado: o modelo de visao ja le bem)
#
# Comandos: ping, status, install, cancelInstall, installVc, start, stop, log, uninstall.
#
# Este arquivo e so ASCII de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HostVersion = 4
$HostName = 'com.tradutor_manhwa.servidor'
$HostDir = $PSScriptRoot
$Root = Split-Path -Parent $HostDir
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$ConfigPath = Join-Path $Root 'config.json'
$InstallState = Join-Path $StateDir 'install.json'
$InstallLog = Join-Path $LogDir 'install.log'
$Utf8 = New-Object System.Text.UTF8Encoding $false

$Engines = @{
  llama = @{ process = 'llama-server'; tag = '^b\d{3,7}$' }
}

foreach ($d in @($StateDir, $LogDir)) {
  if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

# ---------- Protocolo ----------

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exactly([int]$n) {
  $buf = New-Object byte[] $n
  $off = 0
  while ($off -lt $n) {
    $r = $stdin.Read($buf, $off, $n - $off)
    if ($r -le 0) { return $null }
    $off += $r
  }
  return ,$buf
}

function Send-Json($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
  $bytes = $Utf8.GetBytes($json)
  $len = [BitConverter]::GetBytes([int32]$bytes.Length)
  $stdout.Write($len, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# ---------- Utilidades ----------

function Read-JsonFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  for ($i = 0; $i -lt 3; $i++) {
    try { return ([IO.File]::ReadAllText($path, $Utf8) | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 80 }
  }
  return $null
}

# Troca o arquivo de uma vez; se outro processo estiver lendo, tenta de novo.
function Write-JsonFile([string]$path, $obj) {
  $tmp = "$path.tmp"
  $json = ConvertTo-Json -InputObject $obj -Depth 8
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

# Versao do carregador do Vulkan do Windows (vem com o driver da placa de video).
# O ggml precisa de Vulkan 1.2; com um carregador mais antigo o llama.cpp cai
# sozinho para o processador (a extensao avisa na pagina de configuracoes).
$VulkanMin = [version]'1.2.0'
function Get-VulkanLoader {
  $dll = Join-Path $env:WINDIR 'System32\vulkan-1.dll'
  if (-not (Test-Path -LiteralPath $dll)) { return $null }
  try {
    $vi = (Get-Item -LiteralPath $dll).VersionInfo
    return [version]('{0}.{1}.{2}' -f $vi.FileMajorPart, $vi.FileMinorPart, $vi.FileBuildPart)
  } catch { return $null }
}

# Codigos de saida do Windows que explicam um servidor que fechou na hora.
function Explain-Exit([string]$log, [string]$backend) {
  $code = $null
  if (Test-Path -LiteralPath $log) {
    $m = Select-String -LiteralPath $log -Pattern '^EXIT=(-?\d+)' | Select-Object -Last 1
    if ($m) { $code = [int64]$m.Matches[0].Groups[1].Value }
  }
  # o cmd devolve o codigo com sinal (ex.: -1073741511 = 0xC0000139)
  $hex = if ($null -ne $code) { '0x{0:X8}' -f [uint32]$(if ($code -lt 0) { $code + 4294967296 } else { $code }) } else { $null }
  $hint = switch ($hex) {
    '0xC0000139' { if ($backend -eq 'vulkan') { 'O Vulkan deste PC e antigo demais para esta versao (driver da placa de video). Atualize o driver ou reinstale com "Sem placa de video".' } else { 'Falta uma funcao numa DLL do sistema (Windows ou driver desatualizado).' } }
    '0xC0000135' { 'Falta uma DLL: runtime do Visual C++ ou, no modo Vulkan/CUDA, o driver da placa de video.' }
    '0xC000001D' { 'O processador nao tem as instrucoes que este programa usa (AVX2).' }
    '0xC0000005' { 'O programa travou ao carregar o modelo (arquivo corrompido ou falta de memoria).' }
    default { $null }
  }
  return @{ exitCode = $hex; hint = $hint }
}

function Get-Alive($procId, [string]$name) {
  if (-not $procId) { return $null }
  $p = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
  if ($p -and ((-not $name) -or $p.ProcessName -eq $name)) { return $p }
  return $null
}

# Abre um processo fora do "job" do Chrome (via WMI), escondido, para ele
# continuar vivo depois que o Chrome fecha este ajudante.
function Start-Detached([string]$cmdLine, [string]$dir) {
  $si = New-CimInstance -Namespace root/cimv2 -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $r = Invoke-CimMethod -Namespace root/cimv2 -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine; CurrentDirectory = $dir; ProcessStartupInformation = $si
  }
  if ($r.ReturnValue -ne 0) { throw "Nao consegui abrir o processo (WMI $($r.ReturnValue))." }
  return [int]$r.ProcessId
}

function Test-VcRuntime([string]$dir) {
  foreach ($n in @('vcruntime140.dll', 'msvcp140.dll')) {
    $sys = Join-Path $env:WINDIR "System32\$n"
    $local = if ($dir) { Join-Path $dir $n } else { $null }
    if (-not (Test-Path -LiteralPath $sys) -and -not ($local -and (Test-Path -LiteralPath $local))) { return $false }
  }
  return $true
}

function Get-Tail([string]$path, [int]$lines) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  return ((Get-Content -LiteralPath $path -Tail $lines -Encoding UTF8) -join "`n")
}

function Fail([string]$code, [string]$message) {
  return @{ ok = $false; code = $code; error = $message }
}

function Int-In($value, [int]$def, [int]$min, [int]$max) {
  if ($null -eq $value) { return $def }
  $n = 0
  if (-not [int]::TryParse([string]$value, [ref]$n)) { return $def }
  return [Math]::Max($min, [Math]::Min($max, $n))
}

function Powershell-Exe { return (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') }

function Engine-Of($msg) {
  $e = if ($msg.engine) { [string]$msg.engine } else { 'llama' }
  if (-not $Engines.ContainsKey($e)) { throw "Motor desconhecido: $e" }
  return $e
}

function Engine-Config([string]$engine) {
  $cfg = Read-JsonFile $ConfigPath
  if ($cfg -and $cfg.engines -and $cfg.engines.$engine) { return $cfg.engines.$engine }
  return $null
}

function Server-StatePath([string]$engine) { return (Join-Path $StateDir "server-$engine.json") }
function Server-LogPath([string]$engine) { return (Join-Path $LogDir "server-$engine.log") }

function Get-ServerProcess([string]$engine) {
  $srv = Read-JsonFile (Server-StatePath $engine)
  if (-not $srv) { return $null }
  $p = Get-Alive $srv.pid $Engines[$engine].process
  if ($p) { return @{ proc = $p; state = $srv } }
  return $null
}

# ---------- Comandos ----------

function Engine-Status([string]$engine) {
  $ec = Engine-Config $engine
  $runtime = @{ installed = $false }
  if ($ec -and $ec.runtime -and $ec.runtime.exe -and (Test-Path -LiteralPath $ec.runtime.exe)) {
    $runtime = @{ installed = $true; tag = $ec.runtime.tag; backend = $ec.runtime.backend; vcRuntime = (Test-VcRuntime $ec.runtime.dir) }
  }
  $model = @{ installed = $false }
  if ($ec -and $ec.model -and $ec.model.path -and (Test-Path -LiteralPath $ec.model.path)) {
    $vision = [bool]($ec.model.mmprojPath -and (Test-Path -LiteralPath $ec.model.mmprojPath))
    $model = @{ installed = $true; repo = $ec.model.repo; file = $ec.model.file; mmproj = $ec.model.mmproj; vision = $vision; bytes = $ec.model.bytes }
  }
  $server = @{ running = $false }
  $sp = Get-ServerProcess $engine
  if ($sp) { $server = @{ running = $true; pid = $sp.proc.Id; port = $sp.state.port; startedAt = $sp.state.startedAt } }
  return @{ runtime = $runtime; model = $model; server = $server }
}

function Cmd-Status {
  $inst = Read-JsonFile $InstallState
  if ($inst) {
    $alive = [bool](Get-Alive $inst.pid 'powershell')
    $inst | Add-Member -Force -NotePropertyName running -NotePropertyValue $alive
    if (-not $alive -and -not $inst.finished -and $inst.pid) {
      # o instalador morreu sem terminar (PC desligou, processo fechado...)
      $inst.finished = $true
      $inst | Add-Member -Force -NotePropertyName code -NotePropertyValue 'INTERRUPTED'
      $inst | Add-Member -Force -NotePropertyName error -NotePropertyValue 'A instalacao parou no meio.'
      Write-JsonFile $InstallState $inst
    }
  }
  $byEngine = @{}
  foreach ($e in $Engines.Keys) { $byEngine[$e] = Engine-Status $e }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))
  $vk = Get-VulkanLoader
  return @{
    ok = $true; hostVersion = $HostVersion; root = $Root
    engines = $byEngine; install = $inst
    vcRuntime = (Test-VcRuntime $null)
    vulkanLoader = $(if ($vk) { $vk.ToString() } else { $null })
    vulkanOk = [bool]($vk -and $vk -ge $VulkanMin)
    freeBytes = $drive.AvailableFreeSpace
  }
}

function Install-Running {
  $inst = Read-JsonFile $InstallState
  return ($inst -and -not $inst.finished -and (Get-Alive $inst.pid 'powershell'))
}

function Cmd-Install($msg) {
  $engine = Engine-Of $msg
  $backend = [string]$msg.backend
  $tag = [string]$msg.tag
  $repo = [string]$msg.repo
  $quant = if ($msg.quant) { [string]$msg.quant } else { 'Q4_K_M,Q4_0,Q8_0' }
  if ($backend -notin @('cpu', 'vulkan', 'cuda')) { return (Fail 'BAD_ARGS' "Placa de video invalida: $backend") }
  if ($tag -notmatch $Engines[$engine].tag) { return (Fail 'BAD_ARGS' "Versao invalida: $tag") }
  if ($repo -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$') { return (Fail 'BAD_ARGS' "Repositorio invalido: $repo") }
  if ($quant -notmatch '^[A-Za-z0-9_,-]+$') { return (Fail 'BAD_ARGS' "Quantizacao invalida: $quant") }
  if (Install-Running) { return (Fail 'BUSY' 'Ja tem uma instalacao em andamento.') }

  Write-JsonFile $InstallState @{ pid = 0; finished = $false; phase = 'start'; engine = $engine; backend = $backend; tag = $tag; repo = $repo; startedAt = (Get-Date).ToString('o') }
  $script = Join-Path $HostDir 'instalar.ps1'
  $cmd = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Root "{2}" -Engine {3} -Backend {4} -Tag {5} -Repo {6} -Quant {7}' -f (Powershell-Exe), $script, $Root, $engine, $backend, $tag, $repo, $quant
  try {
    $procId = Start-Detached $cmd $HostDir
  } catch {
    Write-JsonFile $InstallState @{ pid = 0; finished = $true; phase = 'start'; engine = $engine; code = 'HOST'; error = $_.Exception.Message }
    throw
  }
  return @{ ok = $true; started = $true; pid = $procId }
}

function Cmd-CancelInstall {
  $inst = Read-JsonFile $InstallState
  if ($inst -and -not $inst.finished) {
    $p = Get-Alive $inst.pid 'powershell'
    if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    $inst.finished = $true
    $inst | Add-Member -Force -NotePropertyName code -NotePropertyValue 'CANCELED'
    $inst | Add-Member -Force -NotePropertyName error -NotePropertyValue 'Instalacao cancelada.'
    Write-JsonFile $InstallState $inst
  }
  return @{ ok = $true }
}

function Cmd-InstallVc {
  if (Install-Running) { return (Fail 'BUSY' 'Ja tem uma instalacao em andamento.') }
  $script = Join-Path $HostDir 'instalar.ps1'
  $cmd = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Root "{2}" -OnlyVcRuntime' -f (Powershell-Exe), $script, $Root
  $procId = Start-Detached $cmd $HostDir
  return @{ ok = $true; started = $true; pid = $procId }
}

# Abre o servidor por um .cmd lancador: quando ele fecha, o lancador grava o
# codigo de saida no log (EXIT=...), que o Explain-Exit traduz. Devolve o PID do
# servidor (filho do cmd), que e o que o status acompanha.
function Start-WithLauncher([string]$engine, [string]$cmdLine, [string]$dir, [string]$log, [string]$exeName) {
  $launcher = Join-Path $StateDir "iniciar-$engine.cmd"
  $lines = @(
    '@echo off',
    'chcp 65001 >nul',
    $cmdLine,
    ('echo EXIT=%ERRORLEVEL%>> "{0}"' -f $log)
  )
  [IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", $Utf8)
  $cmdPid = Start-Detached ('cmd.exe /d /c "{0}"' -f $launcher) $dir
  for ($i = 0; $i -lt 30; $i++) {
    $child = Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $cmdPid AND Name = '$exeName'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($child) { return [int]$child.ProcessId }
    Start-Sleep -Milliseconds 100
  }
  return 0
}

function Start-Llama($ec, $msg, [int]$port, [string]$log) {
  $ctx = Int-In $msg.ctx 8192 2048 262144
  $parallel = Int-In $msg.parallel 2 1 8
  $apiKey = [string]$msg.apiKey
  $origin = [string]$msg.origin
  if ($apiKey -notmatch '^[A-Za-z0-9_-]{16,128}$') { throw 'Chave do servidor invalida.' }
  if ($origin -notmatch '^chrome-extension://[a-p]{32}$') { throw 'Origem invalida.' }
  $keyFile = Join-Path $StateDir 'api-key.txt'
  [IO.File]::WriteAllText($keyFile, $apiKey + "`n", $Utf8)

  $parts = @(('"{0}"' -f $ec.runtime.exe), '-m', ('"{0}"' -f $ec.model.path))
  if ($ec.model.mmprojPath -and (Test-Path -LiteralPath $ec.model.mmprojPath)) { $parts += @('--mmproj', ('"{0}"' -f $ec.model.mmprojPath)) }
  $parts += @(
    '--host', '127.0.0.1', '--port', $port,
    '--api-key-file', ('"{0}"' -f $keyFile),
    '--cors-origins', $origin, '--no-cors-credentials',
    '-c', $ctx, '-np', $parallel,
    '--alias', 'tradutor-local',
    '--no-webui', '--log-colors', 'off',
    '--log-file', ('"{0}"' -f $log)
  )
  # a saida do console (erros antes do log abrir) vai para outro arquivo
  $console = $log -replace '\.log$', '.console.log'
  $cmdLine = ($parts -join ' ') + (' > "{0}" 2>&1' -f $console)
  return (Start-WithLauncher 'llama' $cmdLine $ec.runtime.dir $log 'llama-server.exe')
}

function Cmd-Start($msg) {
  $engine = Engine-Of $msg
  $ec = Engine-Config $engine
  if (-not ($ec -and $ec.runtime -and (Test-Path -LiteralPath $ec.runtime.exe))) { return (Fail 'NOT_INSTALLED' 'O programa ainda nao foi instalado.') }
  if (-not ($ec.model -and (Test-Path -LiteralPath $ec.model.path))) { return (Fail 'NOT_INSTALLED' 'O modelo ainda nao foi baixado.') }
  if (-not (Test-VcRuntime $ec.runtime.dir)) { return (Fail 'NO_VCRUNTIME' 'Falta o runtime do Visual C++.') }

  $sp = Get-ServerProcess $engine
  if ($sp) { return @{ ok = $true; already = $true; pid = $sp.proc.Id; port = $sp.state.port } }

  $port = Int-In $msg.port 18080 1024 65535
  $log = Server-LogPath $engine
  if (Test-Path -LiteralPath $log) { Move-Item -Force -LiteralPath $log -Destination ($log -replace '\.log$', '.anterior.log') }

  $procId = Start-Llama $ec $msg $port $log
  Write-JsonFile (Server-StatePath $engine) @{ pid = $procId; port = $port; startedAt = (Get-Date).ToString('o'); model = $ec.model.repo }

  Start-Sleep -Milliseconds 1500
  if (-not (Get-Alive $procId $Engines[$engine].process)) {
    Start-Sleep -Milliseconds 300   # da tempo do lancador gravar o codigo de saida
    $why = Explain-Exit $log $ec.runtime.backend
    return @{ ok = $false; code = 'START_FAILED'; error = 'O servidor fechou logo depois de abrir.'; exitCode = $why.exitCode; hint = $why.hint; log = (Get-Tail $log 25) }
  }
  return @{ ok = $true; started = $true; pid = $procId; port = $port }
}

function Stop-Engine([string]$engine) {
  $sp = Get-ServerProcess $engine
  if ($sp) { Stop-Process -Id $sp.proc.Id -Force -ErrorAction SilentlyContinue }
  $path = Server-StatePath $engine
  if (Test-Path -LiteralPath $path) { Remove-Item -Force -LiteralPath $path }
  return [bool]$sp
}

function Cmd-Stop($msg) {
  $stopped = Stop-Engine (Engine-Of $msg)
  return @{ ok = $true; stopped = $stopped }
}

function Cmd-Log($msg) {
  $lines = Int-In $msg.lines 60 1 400
  $path = if ($msg.which -eq 'install') { $InstallLog } else { Server-LogPath (Engine-Of $msg) }
  return @{ ok = $true; text = (Get-Tail $path $lines) }
}

function Cmd-Uninstall {
  foreach ($e in $Engines.Keys) { $null = Stop-Engine $e }
  $null = Cmd-CancelInstall
  foreach ($k in @(
      "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
      "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
      "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName")) {
    if (Test-Path $k) { Remove-Item -Recurse -Force $k -ErrorAction SilentlyContinue }
  }
  # apaga a pasta depois que este ajudante fechar
  $cmd = 'cmd.exe /d /c ping -n 4 127.0.0.1 >nul & rmdir /s /q "{0}"' -f $Root
  $null = Start-Detached $cmd $env:TEMP
  return @{ ok = $true }
}

function Invoke-Cmd($msg) {
  switch ([string]$msg.cmd) {
    'ping' { return @{ ok = $true; hostVersion = $HostVersion; root = $Root } }
    'status' { return (Cmd-Status) }
    'install' { return (Cmd-Install $msg) }
    'cancelInstall' { return (Cmd-CancelInstall) }
    'installVc' { return (Cmd-InstallVc) }
    'start' { return (Cmd-Start $msg) }
    'stop' { return (Cmd-Stop $msg) }
    'log' { return (Cmd-Log $msg) }
    'uninstall' { return (Cmd-Uninstall) }
    default { return (Fail 'BAD_CMD' "Comando desconhecido: $($msg.cmd)") }
  }
}

# ---------- Laco principal ----------

while ($true) {
  $head = Read-Exactly 4
  if ($null -eq $head) { break }
  $n = [BitConverter]::ToInt32($head, 0)
  if ($n -le 0 -or $n -gt 1048576) { break }
  $body = Read-Exactly $n
  if ($null -eq $body) { break }
  try {
    $msg = $Utf8.GetString($body) | ConvertFrom-Json
    $res = Invoke-Cmd $msg
  } catch {
    $res = Fail 'HOST' $_.Exception.Message
  }
  Send-Json $res
}
