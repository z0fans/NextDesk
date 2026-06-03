# FreeRDP Sidecar Packaging

NextDesk uses FreeRDP SDL as the default production RDP renderer. IronRDP remains available as the fallback and research path.

## macOS

Run:

```bash
bash scripts/package-freerdp-macos.sh
npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

The packaging script copies the local `sdl-freerdp` binary into:

```text
.backend/freerdp/macos/bin/sdl-freerdp
```

It also recursively copies Homebrew dylib dependencies into:

```text
.backend/freerdp/macos/bin/lib/
```

The script rewrites Homebrew install names to relative paths:

```text
@executable_path/lib/<library>
@loader_path/<library>
```

The final `.app` should contain:

```text
NextDesk.app/Contents/Resources/bin/freerdp/sdl-freerdp
NextDesk.app/Contents/Resources/bin/freerdp/lib/*.dylib
```

The app must not contain `/opt/homebrew` or `/usr/local` references in FreeRDP binaries.

## Windows

Place the Windows FreeRDP SDL binary and its DLL dependencies in:

```text
.backend/freerdp/windows/bin/
```

Required minimum:

```text
.backend/freerdp/windows/bin/sdl-freerdp.exe
.backend/freerdp/windows/bin/*.dll
```

Verify before packaging:

```bash
bash scripts/verify-freerdp-windows.sh
```

Then build on Windows:

```bash
npx tauri build --bundles nsis
```

The Windows Tauri config packages `.backend/freerdp/windows/bin` into the app resource `bin/freerdp` directory, so runtime lookup resolves:

```text
Resources/bin/freerdp/sdl-freerdp.exe
```
