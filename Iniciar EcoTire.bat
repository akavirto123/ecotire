@echo off
chcp 65001 >nul
title EcoTire
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)"
if errorlevel 1 goto oldnode

if not exist node_modules goto install
if exist node_modules\@rolldown\binding-win32-x64-msvc goto run
if exist node_modules\@rolldown\binding-win32-arm64-msvc goto run
echo A instalacao anterior ficou incompleta. Reinstalando do zero...
rmdir /s /q node_modules
if exist package-lock.json del package-lock.json

:install
echo Instalando as dependencias do EcoTire. Isso leva alguns minutos so na primeira vez...
call npm install
if errorlevel 1 goto fail

:run
echo.
echo EcoTire rodando em http://localhost:5173  -  deixe esta janela aberta. Para parar, feche a janela.
echo.
call npm run dev -- --port 5173 --strictPort
pause
exit /b 0

:nonode
echo O Node.js nao esta instalado. Instale a versao LTS em https://nodejs.org e abra este arquivo de novo.
pause
exit /b 1

:oldnode
echo Seu Node.js e antigo demais para este projeto:
node -v
echo Instale a versao LTS atual em https://nodejs.org - precisa ser 22.12 ou mais nova - e abra este arquivo de novo.
pause
exit /b 1

:fail
echo A instalacao falhou. Copie a mensagem acima e mande para o Claude.
pause
exit /b 1
