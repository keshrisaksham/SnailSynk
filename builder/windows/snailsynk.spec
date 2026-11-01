# PyInstaller spec for the portable SnailSynk build (one file, data kept next to it).
# Run through build_exe.bat, or:  pyinstaller --noconfirm --clean builder/windows/snailsynk.spec
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent.parent   # the SnailSynk folder
APP = ROOT / 'app'
VERSION = (ROOT / 'VERSION').read_text().strip()


def data_tree(folder):
    """Every file of a folder as (source, destination folder), minus caches and backup pages."""
    for f in sorted((APP / folder).rglob('*')):
        if f.is_file() and '__pycache__' not in f.parts and not f.name.endswith(('.pyc', '_backup.html')):
            yield (str(f), str(Path(folder) / f.parent.relative_to(APP / folder)))


datas = list(data_tree('templates')) + list(data_tree('static')) + [(str(ROOT / 'VERSION'), '.')]
binaries = []
hiddenimports = collect_submodules('engineio.async_drivers') + ['gevent.ssl', 'geventwebsocket.handler']

# The AI chat library is optional in the code; bundle it whenever the build environment has it.
try:
    d, b, h = collect_all('google.genai')
    datas += d; binaries += b; hiddenimports += h
except Exception:
    pass

a = Analysis(
    [str(APP / 'launcher.py')],
    pathex=[str(APP)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=['tkinter', 'unittest', 'pydoc'],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name=f'SnailSynk-{VERSION}-portable',
    console=True,                  # the first-run questions and the server log live in this window
    upx=False,                     # UPX-packed exes trigger more antivirus warnings
    icon=str(ROOT / 'assets' / 'icon.ico') if sys.platform == 'win32' else None,
)
