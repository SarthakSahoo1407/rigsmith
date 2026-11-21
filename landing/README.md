# Rigsmith landing page

Open `index.html` in a browser, or serve this directory as a static site:

```sh
python3 -m http.server 4178 --directory landing
```

The download is a ZIP of the local Apple silicon standalone build. To refresh it after building the app, run this from the repository root:

```sh
ditto -c -k --keepParent native/build/Rig_artefacts/Release/Rigsmith.app landing/assets/Rigsmith-macOS-arm64.zip
```

The page links to https://github.com/SarthakSahoo1407/rigsmith (source, issues, releases, the Windows build steps). The repository is private for now, so those links only work for people with access: make it public before sharing the page. A Windows download will go here once the Windows build is checked: until then it says to build from source.
