#!/bin/sh
# Builds Rigsmith-macOS.pkg: the app into /Applications, the AU and VST3 into the system plugin folders.
# usage: build-pkg.sh <version> <build dir (native/build)> <output dir>
set -eu
VERSION="${1:?version}"; BUILD="${2:?build dir}"; OUT="${3:?output dir}"
ROOT="$(mktemp -d)/root"
mkdir -p "$ROOT/Applications" "$ROOT/Library/Audio/Plug-Ins/Components" "$ROOT/Library/Audio/Plug-Ins/VST3" "$OUT"
ditto "$BUILD/Rig_artefacts/Release/Rigsmith.app" "$ROOT/Applications/Rigsmith.app"
ditto "$BUILD/RigPlugin_artefacts/Release/AU/Rigsmith.component" "$ROOT/Library/Audio/Plug-Ins/Components/Rigsmith.component"
ditto "$BUILD/RigPlugin_artefacts/Release/VST3/Rigsmith.vst3" "$ROOT/Library/Audio/Plug-Ins/VST3/Rigsmith.vst3"
pkgbuild --root "$ROOT" --identifier com.multifx.rig.installer --version "$VERSION" --install-location / "$OUT/Rigsmith-macOS.pkg"
