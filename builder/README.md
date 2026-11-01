# Building SnailSynk packages

Both packages start through `app/launcher.py`, which keeps everything SnailSynk writes in a data folder
(`SNAILSYNK_HOME`) instead of next to the code, and runs the first-run questions when there is no admin account yet.

| Build | Command | Output | Data folder |
|-------|---------|--------|-------------|
| Debian package | `builder/deb/build_deb.sh` (on Linux) | `dist/snailsynk_<version>_all.deb` | `~/.local/share/snailsynk` |
| Windows portable | `builder\windows\build_exe.bat` (on Windows) | `dist\SnailSynk-<version>-portable.exe` | `SnailSynk-data\` next to the .exe |

The version comes from the `VERSION` file at the repo root (`build_deb.sh 2.1.0` overrides it for the deb).

* The deb depends on Debian's own `python3-*` packages. `google-genai` (AI chat) is not packaged in Debian, so it is optional;
  see `builder/deb/README.Debian`. The exe bundles it.
* `builder/deb/copyright` needs a real licence before the package is given to anyone else.
* The .exe is unsigned, so Windows SmartScreen will warn about it.
