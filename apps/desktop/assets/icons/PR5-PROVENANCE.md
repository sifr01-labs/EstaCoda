# PR5 application icon

- `pr5-supplied-icon.png`: exact user attachment from the PR5 request (1254 × 1254 RGB, baked exterior checkerboard).
- `pr5-app-icon.png`: transparent packaging derivative produced with the image editing tool from that attachment. The request was limited to removing the exterior checkerboard while preserving the tile and blue eye. It is an edited derivative, not the unchanged original.
- `pr5-app.icns`: macOS representations generated with `sips` and `iconutil`, from 16 px through 1024 px, including Retina sizes. Real alpha is present outside the rounded tile.

The older, untracked `estacoda-icon*` assets in this checkout are not the PR5 source and are not used by the packager. In-app brand marks continue to use the separately approved official wordmark and vector eye.

## Dock sizing

The packaged 1024 px representation retains an opaque tile about 891 × 874 px (roughly 87% of the canvas width), with the rounded corners and exterior alpha intact. It already fills the intended Dock footprint; adding another inset would make it look undersized. Development now explicitly uses `pr5-app-icon.png` for the Dock too, instead of Electron's default icon.
