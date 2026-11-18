@echo off
setlocal EnableExtensions DisableDelayedExpansion
title SnailSynk

rem ============================================================================
rem  SnailSynk installer + launcher for Windows
rem
rem    Snail.bat                 first run: friendly setup, then starts the app.
rem                              Every later run just starts the app.
rem    Snail.bat --reset-admin   forgot the admin password? Set a new one.
rem    Snail.bat --setup         run the setup questions again.
rem    Snail.bat --update        pull the latest SnailSynk from GitHub and update this install in place.
rem    Snail.bat --uninstall     remove SnailSynk, but keep your notes and the uploaded files.
rem    Snail.bat --clean-install erase EVERYTHING (notes and uploads too), then install from scratch.
rem    Snail.bat --help          this list.
rem    (add --yes to --update / --uninstall / --clean-install to skip the "are you sure?" question)
rem
rem  This file finds Python, installs the packages and makes the shortcut. The
rem  questions, the admin account and the summary live in app\setup_wizard.py
rem  (so they work the same on every system). No administrator rights are needed.
rem ============================================================================

rem Work in the folder this file lives in, wherever it was started from
pushd "%~dp0.."
set "WIZARD=app\setup_wizard.py"
rem Snail.bat lives in Set-and-Run; the SnailSynk folder one level up is the working directory.
set "SNAIL_BIN=%CD%\Set-and-Run"
set "PY="

if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if /i "%~1"=="/?" goto :help
if /i "%~1"=="--reset-admin" goto :reset_admin
if /i "%~1"=="--update" goto :update
if /i "%~1"=="--uninstall" goto :uninstall
if /i "%~1"=="--clean-install" goto :clean_install
if /i "%~1"=="--setup" del "install.loc" >nul 2>&1
if not "%~1"=="" if /i not "%~1"=="--setup" goto :unknown_option

if exist "install.loc" goto :run_app
goto :install_app


:help
echo.
echo   SnailSynk installer and launcher
echo.
echo     Snail.bat                 first run: setup, then start. After that: just start.
echo     Snail.bat --reset-admin   forgot the admin password? pick a new one.
echo     Snail.bat --setup         run the setup questions again.
echo     Snail.bat --update        pull the latest SnailSynk from GitHub and update this install in place.
echo     Snail.bat --uninstall     remove SnailSynk, keeping your notes and uploaded files.
echo     Snail.bat --clean-install erase everything (notes and uploads too), install from scratch.
echo     Snail.bat --help          show this.
echo       (add --yes to --update, --uninstall or --clean-install to skip the question)
echo.
popd
exit /b 0


:unknown_option
echo.
echo   [x] I don't know what "%~1" means. Try  Snail.bat --help
echo.
popd
exit /b 1


rem ----------------------------------------------------------------------------
rem  Looks for a working Python 3 and puts the command in %PY%
rem  ("py -3" first, then python, then python3). The Microsoft Store stub that
rem  opens the Store when Python is missing fails the test, as it should.
rem ----------------------------------------------------------------------------
:find_python
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if defined PY goto :eof
python -c "import sys" >nul 2>&1 && set "PY=python"
if defined PY goto :eof
python3 -c "import sys" >nul 2>&1 && set "PY=python3"
goto :eof


:no_python
echo.
echo   SnailSynk needs Python 3, and I couldn't find it on this computer.
echo.
where winget >nul 2>&1
if errorlevel 1 goto :python_manual
echo   Good news: I can install it for you with winget. It is free and takes a minute.
set "ANSWER="
set /p "ANSWER=  -> Install Python now? (Y/n): "
if /i "%ANSWER%"=="n" goto :python_manual
if /i "%ANSWER%"=="no" goto :python_manual
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :python_manual
echo.
echo   Python is installed. Close this window and double-click Snail.bat again,
echo   so that Windows notices the new Python.
echo.
pause
popd
exit /b 0

:python_manual
echo   Please install Python 3 from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" in the installer.
echo   Then run Snail.bat again. The snail will wait. It is good at that.
echo.
pause
popd
exit /b 1


rem ============================================================================
rem  First run
rem ============================================================================
:install_app
call :find_python
if not defined PY goto :no_python

cls
%PY% "%WIZARD%" banner --sub "one-time setup"
echo   Welcome! Let's get your snail moving.
echo     This takes about a minute. Snails are slow, but we're not.

echo.
echo [1/4] Checking for Python
%PY% --version
echo   [OK] Python is ready.

echo.
echo [2/4] Installing the ingredients
echo     This is the slow part. Your internet connection is being tested. Politely.
%PY% -m pip install -r requirements.txt --disable-pip-version-check -q
if not errorlevel 1 goto :deps_ok
echo     That needs more permission here. Trying a per-user install instead...
%PY% -m pip install -r requirements.txt --user --disable-pip-version-check -q
if errorlevel 1 goto :deps_failed
:deps_ok
echo   [OK] All packages installed.

echo.
echo [3/4] A few questions
%PY% "%WIZARD%" ask
if errorlevel 1 goto :wizard_failed

echo.
echo [4/4] Finishing touches
set "SNAIL_DIR=%CD%"

rem Add this folder to your PATH (your own, not the system one), so "Snail" works in any new terminal
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:SNAIL_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';')+';'+$d).TrimStart(';')),'User')}" >nul 2>&1
if errorlevel 1 goto :path_skipped
echo   [OK] Type  Snail  in any NEW terminal to start SnailSynk.
goto :path_done
:path_skipped
echo   [!] Couldn't add SnailSynk to your PATH. Not a big deal.
:path_done

rem Desktop shortcut (this also finds a Desktop that OneDrive moved)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\SnailSynk.lnk'); $s.TargetPath=$env:SNAIL_BIN+'\Snail.bat'; $s.WorkingDirectory=$env:SNAIL_DIR; $s.IconLocation=$env:SNAIL_DIR+'\assets\icon.ico'; $s.Save()" >nul 2>&1
if errorlevel 1 goto :shortcut_skipped
echo   [OK] Desktop shortcut created.
goto :shortcut_done
:shortcut_skipped
echo   [!] Couldn't create the desktop shortcut. Not a big deal.
:shortcut_done

echo Installation completed on %date% at %time%> install.loc

%PY% "%WIZARD%" done --cmd "type  Snail  in a new terminal, or use the desktop shortcut." --reset "Snail.bat --reset-admin"
pause
goto :run_app


:deps_failed
echo.
echo   [x] pip couldn't install everything. The message above says why.
echo       Most often this is the internet connection. Fix it and run Snail.bat again.
echo.
pause
popd
exit /b 1

:wizard_failed
echo.
echo   [x] The setup questions were interrupted, so nothing was finished.
echo       Run Snail.bat again whenever you are ready.
echo.
pause
popd
exit /b 1


rem ============================================================================
rem  Every run after that
rem ============================================================================
:run_app
call :find_python
if not defined PY goto :no_python

cls
%PY% "%WIZARD%" banner

rem Open the browser as soon as the server is listening (not after a blind delay)
start "" /b %PY% "%WIZARD%" open-browser

%PY% app\SnailSynk.py
set "RC=%ERRORLEVEL%"

%PY% "%WIZARD%" bye --rc %RC%
echo.
pause
popd
exit /b %RC%


:reset_admin
call :find_python
if not defined PY goto :no_python
%PY% "%WIZARD%" reset-admin
set "RC=%ERRORLEVEL%"
echo.
pause
popd
exit /b %RC%


rem ============================================================================
rem  Update: pulls the latest version from GitHub (Set-and-Run\upgrade.py keeps
rem  .env, instance\ and uploaded files untouched)
rem ============================================================================
:update
call :find_python
if not defined PY goto :no_python
set "CLEAN_YES="
if /i "%~2"=="--yes" set "CLEAN_YES=1"
if /i "%~2"=="-y" set "CLEAN_YES=1"
cls
%PY% "%WIZARD%" banner --sub "update"
if defined CLEAN_YES goto :update_go
echo   This downloads the latest SnailSynk from GitHub and replaces the app files.
echo   Your .env, instance data and uploaded files are left untouched.
set "ANSWER="
set /p "ANSWER=  -> Proceed with update? (y/N): "
if /i not "%ANSWER%"=="y" if /i not "%ANSWER%"=="yes" goto :update_cancelled
:update_go
echo.
echo [1/2] Fetching the latest version
%PY% -B "Set-and-Run\upgrade.py" --target "%CD%" --yes
if errorlevel 1 goto :update_failed
echo   [OK] Files updated.

echo.
echo [2/2] Making sure dependencies are up to date
%PY% -m pip install -r requirements.txt --disable-pip-version-check -q
if not errorlevel 1 goto :update_deps_ok
%PY% -m pip install -r requirements.txt --user --disable-pip-version-check -q
if errorlevel 1 goto :update_deps_warn
:update_deps_ok
echo   [OK] Dependencies are up to date.
goto :update_done
:update_deps_warn
echo   [!] Some dependencies may not have installed cleanly.
:update_done

echo.
echo   [OK] Update complete. Restart SnailSynk to use the new version.
echo.
pause
popd
exit /b 0

:update_failed
echo.
echo   [x] Update failed. Your existing installation was left as-is.
echo.
pause
popd
exit /b 1

:update_cancelled
echo.
echo   Update cancelled.
echo.
pause
popd
exit /b 1


rem ============================================================================
rem  Uninstall: removes the program, keeps notes and uploaded files
rem  (the deleting is done by Set-and-Run\cleanup.py)
rem ============================================================================
:uninstall
call :find_python
if not defined PY goto :no_python
set "CLEAN_YES="
if /i "%~2"=="--yes" set "CLEAN_YES=1"
if /i "%~2"=="-y" set "CLEAN_YES=1"
cls
%PY% "%WIZARD%" banner --sub "uninstall"
if defined CLEAN_YES goto :uninstall_go
%PY% -B "Set-and-Run\cleanup.py" uninstall --ask-only
if errorlevel 1 goto :cleanup_cancelled
:uninstall_go
set "SNAIL_DIR=%CD%"
rem Remove the desktop shortcut and take this folder out of your PATH again
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=[Environment]::GetFolderPath('Desktop')+'\SnailSynk.lnk'; if(Test-Path $f){Remove-Item $f -Force}; $d=$env:SNAIL_BIN; $p=[Environment]::GetEnvironmentVariable('Path','User'); if($p){$n=(($p -split ';') | Where-Object { $_ -and $_ -ne $d -and $_ -ne $env:SNAIL_DIR }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User')}" >nul 2>&1
echo   [OK] Removed the shortcut and the PATH entry.
rem Everything below is in one block on purpose: cmd reads it all before it runs, so it is fine that Python deletes this file.
(
  %PY% -B "Set-and-Run\cleanup.py" uninstall --yes
  echo.
  popd
  exit /b 0
)


rem ============================================================================
rem  Clean install: erase ALL data (notes and uploads too), then set up again
rem ============================================================================
:clean_install
call :find_python
if not defined PY goto :no_python
set "CLEAN_YES="
if /i "%~2"=="--yes" set "CLEAN_YES=1"
if /i "%~2"=="-y" set "CLEAN_YES=1"
cls
%PY% "%WIZARD%" banner --sub "clean install"
if defined CLEAN_YES goto :clean_go
%PY% -B "Set-and-Run\cleanup.py" clean --ask-only
if errorlevel 1 goto :cleanup_cancelled
:clean_go
%PY% -B "Set-and-Run\cleanup.py" clean --yes
if errorlevel 1 goto :cleanup_cancelled
goto :install_app


:cleanup_cancelled
echo.
pause
popd
exit /b 1
