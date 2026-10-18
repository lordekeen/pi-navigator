# Changelog

## [0.18.4](https://github.com/lordekeen/pi-navigator/compare/v0.18.3...v0.18.4) (2026-10-18)


### Bug Fixes

* **viewer,settings:** typed commit target, exclusive settings tmp, images split ([#223](https://github.com/lordekeen/pi-navigator/issues/223), [#224](https://github.com/lordekeen/pi-navigator/issues/224), [#225](https://github.com/lordekeen/pi-navigator/issues/225), [#226](https://github.com/lordekeen/pi-navigator/issues/226), [#237](https://github.com/lordekeen/pi-navigator/issues/237)) ([#238](https://github.com/lordekeen/pi-navigator/issues/238)) ([3cc4d5f](https://github.com/lordekeen/pi-navigator/commit/3cc4d5fe90b3ceaa633b34d3df05e370ddf83052))

## [0.18.3](https://github.com/lordekeen/pi-navigator/compare/v0.18.2...v0.18.3) (2026-10-18)


### Bug Fixes

* **test:** await the load settle in the reflow race ([#233](https://github.com/lordekeen/pi-navigator/issues/233)) ([#234](https://github.com/lordekeen/pi-navigator/issues/234)) ([0c34ca0](https://github.com/lordekeen/pi-navigator/commit/0c34ca0845ff6eeaa1b7a97ddf8348e87ab1b69a))
* viewer and pane state (Phase 3) ([#205](https://github.com/lordekeen/pi-navigator/issues/205), [#207](https://github.com/lordekeen/pi-navigator/issues/207), [#208](https://github.com/lordekeen/pi-navigator/issues/208), [#212](https://github.com/lordekeen/pi-navigator/issues/212), [#213](https://github.com/lordekeen/pi-navigator/issues/213), [#214](https://github.com/lordekeen/pi-navigator/issues/214), [#215](https://github.com/lordekeen/pi-navigator/issues/215), [#217](https://github.com/lordekeen/pi-navigator/issues/217), [#218](https://github.com/lordekeen/pi-navigator/issues/218)) ([#236](https://github.com/lordekeen/pi-navigator/issues/236)) ([98b92af](https://github.com/lordekeen/pi-navigator/commit/98b92af03534745c0f67bd02692eb77b6c549b47))

## [0.18.2](https://github.com/lordekeen/pi-navigator/compare/v0.18.1...v0.18.2) (2026-10-16)


### Bug Fixes

* **git:** correct porcelain, prefixes, gitlinks, path bytes and git-pane keys ([#202](https://github.com/lordekeen/pi-navigator/issues/202), [#203](https://github.com/lordekeen/pi-navigator/issues/203), [#204](https://github.com/lordekeen/pi-navigator/issues/204), [#211](https://github.com/lordekeen/pi-navigator/issues/211), [#219](https://github.com/lordekeen/pi-navigator/issues/219), [#220](https://github.com/lordekeen/pi-navigator/issues/220)) ([#231](https://github.com/lordekeen/pi-navigator/issues/231)) ([837823b](https://github.com/lordekeen/pi-navigator/commit/837823b54a684ddf6da84017f23ae74b4adf6393))
* **panels:** sanitize repo-controlled content before it reaches a row ([#201](https://github.com/lordekeen/pi-navigator/issues/201), [#216](https://github.com/lordekeen/pi-navigator/issues/216)) ([#229](https://github.com/lordekeen/pi-navigator/issues/229)) ([8425b1a](https://github.com/lordekeen/pi-navigator/commit/8425b1a816ce7b74e51fa47bb0a634fe8b111186))

## [0.18.1](https://github.com/lordekeen/pi-navigator/compare/v0.18.0...v0.18.1) (2026-10-15)


### Bug Fixes

* **ci:** gate the npm publish jobs behind the npm-publish environment ([#183](https://github.com/lordekeen/pi-navigator/issues/183)) ([f0d22de](https://github.com/lordekeen/pi-navigator/commit/f0d22de41946eb1fe639fb377d177eb680668db0))
* **frame:** cut an over-wide right segment deliberately in joinLeftRight ([#189](https://github.com/lordekeen/pi-navigator/issues/189)) ([bf620d5](https://github.com/lordekeen/pi-navigator/commit/bf620d5d23f94c6222e3122891e6f715f5ff4596))
* **git_view:** guard the commit-depth walk against parent cycles ([#188](https://github.com/lordekeen/pi-navigator/issues/188)) ([bf9583f](https://github.com/lordekeen/pi-navigator/commit/bf9583f459a4dfbbea46937e4cde316a51583b50))
* **git:** a spawn ENOENT with a missing cwd no longer disables git ([#186](https://github.com/lordekeen/pi-navigator/issues/186)) ([20f0f3b](https://github.com/lordekeen/pi-navigator/commit/20f0f3b27b8fef693e10f005ad2ca92dfd048711))
* **git:** notice a binary commit diff and bound the composed array ([#187](https://github.com/lordekeen/pi-navigator/issues/187)) ([f974ab7](https://github.com/lordekeen/pi-navigator/commit/f974ab7b48ced22ba018fbfc81a3b1761893efb5))
* **help:** require a description in the modal row predicate ([#191](https://github.com/lordekeen/pi-navigator/issues/191)) ([df595d0](https://github.com/lordekeen/pi-navigator/commit/df595d0efe9abaca0d253fb835fac66a1c68fbaa))
* **icons:** never resolve Object.prototype members as glyphs ([#190](https://github.com/lordekeen/pi-navigator/issues/190)) ([6722979](https://github.com/lordekeen/pi-navigator/commit/6722979ea48d7ad952560fab71506c6a2453adac))
* **images:** skip complete foreign kitty replies instead of dropping the buffer ([#193](https://github.com/lordekeen/pi-navigator/issues/193)) ([ae4201c](https://github.com/lordekeen/pi-navigator/commit/ae4201cae204665605c458be09f5c1e8a202b2d9))
* **index:** release the kitty probe on early close; guard the overlay entry ([#185](https://github.com/lordekeen/pi-navigator/issues/185)) ([dec7d34](https://github.com/lordekeen/pi-navigator/commit/dec7d34a9e53092fb13bcd348a2d77932fa71947))
* **session:** never cache a superseded load's failure-free card ([#184](https://github.com/lordekeen/pi-navigator/issues/184)) ([cf39916](https://github.com/lordekeen/pi-navigator/commit/cf39916f58bbc3f0bd839b47dde341d1dc6b7861))
* **session:** publish the in-flight target only for image loads ([#182](https://github.com/lordekeen/pi-navigator/issues/182)) ([5a44312](https://github.com/lordekeen/pi-navigator/commit/5a443127ef2726cdc66f7c9bdbecc2ccfe1c44d0))
* **settings_menu,index:** settle the menu once and route subcommands by exact token ([#198](https://github.com/lordekeen/pi-navigator/issues/198)) ([73bcac1](https://github.com/lordekeen/pi-navigator/commit/73bcac1fc49943d5198379fcd8c031009fe2438a))
* **theme:** keep the current search match distinct without underline ([#194](https://github.com/lordekeen/pi-navigator/issues/194)) ([cadb2fc](https://github.com/lordekeen/pi-navigator/commit/cadb2fcb121e9fa0578d0f18f21ed85c2ad5c0ac))
* **tree,files_view:** map folded name hits and pluralize the match count ([#195](https://github.com/lordekeen/pi-navigator/issues/195)) ([07d234a](https://github.com/lordekeen/pi-navigator/commit/07d234a9470cdfcf44c817c330f74a996ea44b4a))
* **tree:** seed the partial walk at the directory's tree depth ([#192](https://github.com/lordekeen/pi-navigator/issues/192)) ([d641f09](https://github.com/lordekeen/pi-navigator/commit/d641f09a226c1f83acb7e6b08d90ae6e79abc475))

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
