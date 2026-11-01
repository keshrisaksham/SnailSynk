@echo off
rem ============================================================================
rem Builds the portable SnailSynk .exe. Run this ON WINDOWS (PyInstaller cannot
rem cross-compile from Linux). Needs 64-bit Python 3.9 or newer on the PATH.
rem
rem   builder\windows\build_exe.bat
rem
rem Result: dist\SnailSynk-<version>-portable.exe  (one file, no install needed)
rem Settings and data are kept in a SnailSynk-data folder next to the .exe.
rem ============================================================================
setlocal
cd /d "%~dp0..\.."

set /p VERSION=<VERSION
echo.
echo == Building SnailSynk %VERSION% portable ==

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
    where python >nul 2>nul
    if not errorlevel 1 set "PY=python"
)
if not defined PY (
    echo [x] Python 3 was not found. Install it from https://www.python.org/downloads/ and tick "Add to PATH".
    goto :fail
)

rem A clean virtual environment keeps the exe small: only SnailSynk's own packages go in.
if not exist build\exe-venv\Scripts\python.exe (
    echo == Creating a build environment ==
    %PY% -m venv build\exe-venv
    if errorlevel 1 goto :fail
)
set "VPY=build\exe-venv\Scripts\python.exe"

echo == Installing packages ==
"%VPY%" -m pip install --upgrade pip
if errorlevel 1 goto :fail
"%VPY%" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 goto :fail

echo == Building the exe (this takes a few minutes) ==
"%VPY%" -m PyInstaller --noconfirm --clean --distpath dist --workpath build\exe builder\windows\snailsynk.spec
if errorlevel 1 goto :fail

echo.
echo [+] Done: dist\SnailSynk-%VERSION%-portable.exe
echo     Copy that one file anywhere and double-click it.
echo     Windows SmartScreen may warn about an unsigned app: click "More info", then "Run anyway".
goto :end

:fail
echo.
echo [x] The build failed. The message above says why.
endlocal
if /i not "%~1"=="--no-pause" pause
exit /b 1

:end
endlocal
if /i not "%~1"=="--no-pause" pause
exit /b 0
