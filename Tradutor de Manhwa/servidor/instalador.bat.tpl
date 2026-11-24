<# :
@echo off
title Tradutor de Manhwa - servidor local
"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0'))"
echo.
pause
exit /b
#>
# Modelo do instalador do ajudante do servidor local. A pagina de opcoes da
# extensao troca os marcadores (ID da extensao e os scripts em base64) e
# entrega como "instalar-servidor-tradutor.bat". Rodar uma vez so.
#
# O que ele faz (sem precisar de administrador, exceto o runtime do Visual C++):
#   1. grava host.ps1, instalar.ps1 e host.bat em %LOCALAPPDATA%\TradutorManhwa\host
#   2. registra o ajudante no Chrome/Edge/Brave (HKCU\...\NativeMessagingHosts)
#   3. se faltar, instala o runtime do Visual C++ (o Windows pede permissao)

$ErrorActionPreference = 'Stop'
$ExtId = '__EXT_ID__'
$HostName = 'com.tradutor_manhwa.servidor'
$Root = Join-Path $env:LOCALAPPDATA 'TradutorManhwa'
$HostDir = Join-Path $Root 'host'
$Utf8 = New-Object System.Text.UTF8Encoding $false

try {
  Write-Host ''
  Write-Host 'Tradutor de Manhwa - instalando o ajudante do servidor local'
  Write-Host '------------------------------------------------------------'
  Write-Host "Pasta: $Root"
  $null = New-Item -ItemType Directory -Force -Path $HostDir

  function Put([string]$name, [string]$b64) {
    [IO.File]::WriteAllBytes((Join-Path $HostDir $name), [Convert]::FromBase64String($b64))
  }
  Put 'host.ps1' '__HOST_PS1__'
  Put 'instalar.ps1' '__INSTALAR_PS1__'

  $bat = "@echo off`r`n""%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""%~dp0host.ps1""`r`n"
  [IO.File]::WriteAllText((Join-Path $HostDir 'host.bat'), $bat, [Text.Encoding]::ASCII)

  $manifestPath = Join-Path $HostDir "$HostName.json"
  $manifest = [ordered]@{
    name = $HostName
    description = 'Tradutor de Manhwa - servidor local (llama.cpp)'
    path = (Join-Path $HostDir 'host.bat')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
  }
  [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest), $Utf8)
  Write-Host '[ok] arquivos do ajudante gravados'

  if (-not $env:TM_TEST_NO_SYSTEM) {
    foreach ($k in @(
        "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
        "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
        "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName")) {
      $null = New-Item -Path $k -Value $manifestPath -Force
    }
    Write-Host '[ok] ajudante registrado no navegador'

    Write-Host ''
    Write-Host 'Conferindo o runtime do Visual C++ (o llama.cpp precisa dele)...'
    & (Join-Path $HostDir 'instalar.ps1') -Root $Root -OnlyVcRuntime -Wait
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[!] O runtime do Visual C++ nao foi instalado. Da para tentar de novo pela pagina de configuracoes da extensao.'
    } else {
      Write-Host '[ok] runtime do Visual C++'
    }
  }

  Write-Host ''
  Write-Host 'Pronto! Volte para as configuracoes da extensao e clique em "Verificar de novo".'
  Write-Host 'O download do llama.cpp e do modelo e feito por la.'
} catch {
  Write-Host ''
  Write-Host ('[ERRO] ' + $_.Exception.Message)
}
