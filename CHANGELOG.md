# Changelog

## [0.18.0](https://github.com/lordekeen/pi-navigator/compare/v0.17.0...v0.18.0) (2026-10-15)


### Features

* **minimap:** colour the map (diff mirror + syntax voting) ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([b894e7f](https://github.com/lordekeen/pi-navigator/commit/b894e7f192db4bafeb63e6120c1928164db2098e))
* **minimap:** fold, band and encode the viewer map ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([fc33906](https://github.com/lordekeen/pi-navigator/commit/fc33906cc4b12d05c5dd22ecf3d9019fbe31c115))
* **minimap:** mark search matches in the map ([#166](https://github.com/lordekeen/pi-navigator/issues/166)) ([e3d4c04](https://github.com/lordekeen/pi-navigator/commit/e3d4c04f49c1bb9d8171ccd4e007adc269579793))
* **minimap:** wider default, a content divider, and the sole position cue ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([ca426b7](https://github.com/lordekeen/pi-navigator/commit/ca426b7bd97a71cc2da92caed09a7a177d6b3c85))
* **navigator,help:** toggle the minimap with v ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([63303c0](https://github.com/lordekeen/pi-navigator/commit/63303c0859cbb362de9bb950d61823dd730055f0))
* **navigator:** click the minimap to jump the viewer ([#167](https://github.com/lordekeen/pi-navigator/issues/167)) ([1355e3a](https://github.com/lordekeen/pi-navigator/commit/1355e3acc5ccff0600750dbb9599bd266d26ff61))
* **settings:** add the three viewer minimap fields ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([4fdc15b](https://github.com/lordekeen/pi-navigator/commit/4fdc15b1f464264a85913e61cfb38f6ff7f888cd))
* **viewer,theme:** add inkRuns and the captured-SGR syntax pass-through ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([9219b00](https://github.com/lordekeen/pi-navigator/commit/9219b004b033bf92b36726d2eec43b1007cadfee))
* **viewer:** carve the minimap column into the viewer pane ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([cd96f72](https://github.com/lordekeen/pi-navigator/commit/cd96f72591890f7b867b1c3a78a2954f85915b95))


### Bug Fixes

* **minimap:** fold into the content area, and pin what the review found unpinned ([#165](https://github.com/lordekeen/pi-navigator/issues/165)) ([474dd3c](https://github.com/lordekeen/pi-navigator/commit/474dd3c64af97c63462cdd49b0c7d4ed4cdc245f))
* **viewer:** never match or style escape bytes in search ([#181](https://github.com/lordekeen/pi-navigator/issues/181)) ([30a7888](https://github.com/lordekeen/pi-navigator/commit/30a7888495de88f25e1f457a83827a7720e89abc))


### Performance Improvements

* **navigator:** wrap once per cache miss and mark only the visible window ([#168](https://github.com/lordekeen/pi-navigator/issues/168)) ([65b2030](https://github.com/lordekeen/pi-navigator/commit/65b20303e429e2b59eced8cf28e9ad273c5ad3a3))
* **session:** cache repo detection per session, record the viewer-cache decision ([#170](https://github.com/lordekeen/pi-navigator/issues/170)) ([d787d00](https://github.com/lordekeen/pi-navigator/commit/d787d001f705b01eab6dbd92d026a2e04d7a4367))

## [0.17.0](https://github.com/lordekeen/pi-navigator/compare/v0.16.0...v0.17.0) (2026-10-13)


### Features

* **viewer:** estimate the open file's tokens in the viewer header ([#160](https://github.com/lordekeen/pi-navigator/issues/160)) ([4f730ab](https://github.com/lordekeen/pi-navigator/commit/4f730ab54a9265414e5c6516bcf7386215f22c26))

## Changelog

All notable changes to this project are documented in this file. Versions
follow [semantic versioning](https://semver.org/); releases are cut
automatically from [conventional commits](https://www.conventionalcommits.org/)
by [release-please](.github/workflows/release-please.yml).
