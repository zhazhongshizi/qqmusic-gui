# Rhine scene source

Upstream: https://github.com/LBEILC/RhineLabUI/tree/3f4b9c9e8fdc9c6aa689e8c0b2faa5c53df93826
Copyright (c) 2026 LBEILC. Code license: [MIT](LICENSE).

This contains the dependency closures of ArchiveScene and the 2D BootSequence, not the upstream web application. The source is in src; pnpm build:rhine emits JS and declarations into the ignored src/features/rhine/vendor directory. The upstream strict TypeScript settings are kept in a separate project; the application retains noUncheckedIndexedAccess. Do not edit generated files.

The opening (`boot*.ts`) is adapted from upstream commit `ee5779741c6c0c916e416705fa634c7abf905c73`. It retains the frame-driven logo, orbit, lettering and welcome tracks from app time 1.76 to 21.92 seconds, then enters the local music archive instead of opening an upstream demo document. `boot-markup.ts` extracts only static opening markup from main.ts. The lettering artwork is stored as a TypeScript data module; optional licensed webfont loading and global theme integration are omitted. All opening styles are scoped in `src/features/rhine/rhine-boot.css`. No upstream audio is included. The existing MIT notice and resource-rights statement below also apply to this adaptation.

Local adaptations:
- data.ts maps the current playlist page to archive positions and labels, replacing demo lore.
- asset-url.ts resolves bundled model URLs; no upstream PWA or remote host is loaded.
- scene.ts prints the selected playlist title; relative .ts import suffixes were removed for compilation.
- scene.ts adds a deck presentation within the existing renderer: front-facing camera framing, background array retreat/culling, clear shell, and separate optical motion indicators driven by playback state. Reduced motion and disposal also cover this presentation.
- The React ArchiveCanvas wrapper owns loading, visibility, resize and disposal. RhineBoot owns the opening timeline, skip, reduced motion, visibility pause and cleanup. No upstream application main.ts, global CSS, audio, or PWA runtime is included.

The two GLB files in src/features/rhine/assets originate from the upstream project. The upstream README, consulted on 2026-10-04, explicitly includes the author's own original cassette and assembly models in its MIT permission for use, adaptation, screenshots and redistribution. Keep [the upstream MIT notice](LICENSE). This permission excludes third-party Arknights names, marks, original-work visual elements and other independently licensed resources. See the upstream [开源许可 statement](https://github.com/LBEILC/RhineLabUI#开源许可); its resource authorization does not grant rights belonging to other authors.
