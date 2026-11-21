# Rigsmith landing page

Open `index.html` in a browser, or serve this directory as a static site:

```sh
python3 -m http.server 4178 --directory landing
```

The download is a ZIP of the local Apple silicon standalone build. To refresh it after building the app, run this from the repository root:

```sh
ditto -c -k --keepParent native/build/Rig_artefacts/Release/Rigsmith.app landing/assets/Rigsmith-macOS-arm64.zip
```

When the GitHub repository opens, replace the pending star control in `index.html` with a link to the repository and point the contribution action to its contribution guide or issue tracker.
