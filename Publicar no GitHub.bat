@echo off
chcp 65001 >nul
title Publicar EcoTire no GitHub
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 goto nogit
where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist .git (
  git init -b main
  git remote add origin https://github.com/akavirto123/ecotire.git
)
git config user.name >nul 2>nul || git config user.name "akavirto123"
git config user.email >nul 2>nul || git config user.email "akavirto123@users.noreply.github.com"

if not exist node_modules\gh-pages (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 goto fail
)

echo.
echo 1/2 Salvando o codigo no GitHub. Se abrir uma janela de login, entre com a conta akavirto123.
git add -A
git commit -m "Atualiza EcoTire"
git push -u origin main
if errorlevel 1 goto fail

echo.
echo 2/2 Gerando e publicando o site...
call npm run deploy
if errorlevel 1 goto fail

echo.
echo Pronto!
echo Codigo: https://github.com/akavirto123/ecotire
echo Site:   https://akavirto123.github.io/ecotire/
echo Na primeira vez, ative em Settings ^> Pages: Source = Deploy from a branch, Branch = gh-pages.
pause
exit /b 0

:nogit
echo O Git nao esta instalado. Instale em https://git-scm.com/download/win (Next em tudo) e abra este arquivo de novo.
pause
exit /b 1

:nonode
echo O Node.js nao esta instalado. Instale a versao LTS em https://nodejs.org e abra este arquivo de novo.
pause
exit /b 1

:fail
echo.
echo Algo falhou. Copie a mensagem acima e mande para o Claude.
pause
exit /b 1
