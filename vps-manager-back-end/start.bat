@echo off
chcp 65001 >nul
title Central Apps Hub
cd /d "%~dp0"

echo.
echo  ========================================
echo   Central Apps Hub
echo  ========================================
echo   Iniciando Ubuntu (WSL)...
echo   A janela vai ficar aberta para voce ver o log.
echo.

where wsl.exe >nul 2>&1
if errorlevel 1 (
  echo ERRO: wsl.exe nao encontrado.
  echo Abra o PowerShell como Administrador e rode:
  echo   wsl --install -d Ubuntu
  echo.
  pause
  exit /b 1
)

wsl.exe -l -q >nul 2>&1
if errorlevel 1 (
  echo ERRO: o WSL ainda nao esta pronto.
  echo Abra o PowerShell como Administrador e rode:
  echo   wsl --install -d Ubuntu
  echo Depois reinicie o Windows e execute este arquivo de novo.
  echo.
  pause
  exit /b 1
)

wsl.exe -d Ubuntu -- bash -lc "export KEEP_WINDOW_OPEN=1; cd \"$(wslpath -a '%CD%')\" && sed -i 's/\r$//' ./start.sh && bash ./start.sh --prod; code=$?; echo; echo Codigo de saida: $code; echo; read -r -p 'Pressione Enter para fechar... '; exit $code"
set ERR=%ERRORLEVEL%

echo.
if not "%ERR%"=="0" (
  echo O Ubuntu encerrou com erro %ERR%.
  echo Se a janela do WSL so piscou, abra o PowerShell e rode:
  echo   wsl -d Ubuntu
  echo para criar o usuario Linux na primeira vez.
)
echo.
pause
exit /b %ERR%
