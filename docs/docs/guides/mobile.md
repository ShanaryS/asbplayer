---
sidebar_position: 7.5
---

import project from '@site/src/project';

# Mobile (Android & iOS) {#mobile}

While the UX is more limited than on desktop, it's possible to use asbplayer on Android and iOS devices.

## Website {#website}

The <a href={project.urls.app}>website</a> can be used on both Android and iOS. On mobile devices, the **Overlay UI** is displayed at the top of the video when paused alongside touch gestures for playback and seeking.

As a progressive web app, the website can also be installed to your home screen for offline use. See [Offline Usage](./offline-usage.md#add-to-home-screen) for PWA setup.

### Video gestures {#video-gestures}

- **Single tap** on the video (or letterbox area) toggles play and pause.
- **Double tap left or right** (outer 35% of the screen) seeks backward or forward by the configured [Seek interval](../reference/settings.md#seek-interval-seconds) without pausing playback. Additional rapid taps on the same side accumulate continuously.
- **Swipe left or right** seeks to the start of the previous (swipe left) or next (swipe right) subtitle.

### Mobile overlay {#mobile-overlay}

The mobile overlay pill appears at the top of the video whenever playback is paused (or while recording).

- **Swipe up or down** on the center readout to switch between three modes:
  1. **Current timestamp** (`0:00`)
  2. **Subtitle offset** (`±0.00`)
  3. **Playback rate** (`×1.00`)
- **Tap the offset or playback rate readout** to type an exact value directly.
- **Tap `<` or `>`** next to the readout:
  - In **timestamp** mode, seeks to the previous or next subtitle (or by the configured [Seek interval](../reference/settings.md#seek-interval-seconds) when no subtitles are loaded).
  - In **subtitle offset** mode, shifts the subtitle offset to align the previous or next subtitle to the current timestamp.
  - In **playback rate** mode, decreases or increases playback speed by the configured [Playback speed adjust step](../reference/settings.md#playback-speed-adjust-step).
- **Press and hold `<` or `>`** to repeatedly adjust subtitle offset by ±100ms (in offset mode) or playback speed by the configured [Playback speed adjust step](../reference/settings.md#playback-speed-adjust-step) (in playback rate mode).
- **Action buttons** on the pill let you mine the current subtitle (or start/stop manual recording when no subtitles are loaded), toggle subtitle visibility, and open the playback modes and recipes selector.

## Android {#android}

Browser extensions and AnkiConnect Android are specific to Android devices.

### Extension {#extension}

:::warning
**Many features are missing**: the **side panel**, **screenshots**, and the **WebSocket interface**. See the [compatibility](../compatibility.md#browsers-and-features) section for a table of supported and unsupported features on each browser.
:::

As with the website, the primary way to interact with the asbplayer extension is through the **Overlay UI**. The side panel is missing, so instead **subtitles are loaded by selecting the asbplayer button from the browser's extension menu**. Using a (Bluetooth) keyboard is not necessary but can be very useful for those who prefer to use the [keyboard shortcuts](../reference/settings.md#keyboard-shortcuts) with the extension.

Below are Android browsers where asbplayer can be installed.

#### Firefox for Android {#firefox-for-android}

Install asbplayer from the <a href={project.extension.firefoxAndroid.storeUrl}>AMO page</a>. Firefox for Android suffers from the same limitations as Firefox - it's not possible to record audio from DRM-protected streams.

#### Edge Canary {#edge-canary}

Edge Canary is another Chromium-based mobile browser that can run extensions. As of this writing, asbplayer on Edge Canary does not support audio recording.
To install asbplayer on Edge Canary:

1. Download the asbplayer `crx` file from the <a href={`${project.urls.repo}/releases/latest`}>releases page</a>.
2. If not already, enable developer mode from the Edge Canary settings by going to "about Microsoft Edge" and tapping on the build version string several times.
3. From **Developer Options** tap **Extension install by crx** and select the `crx` file you just downloaded.

#### Kiwi Browser (discontinued) {#kiwi-browser-discontinued}

Kiwi Browser is a Chromium-based mobile browser that can run extensions. However, its development has been discontinued and the only way to install it is from the [GitHub page](https://github.com/kiwibrowser/src.next/releases). Once Kiwi Browser is installed, asbplayer can be installed from the Chrome <a href={project.extension.chrome.storeUrl}>web store</a>.

### Anki integration {#anki-integration}

Install [AnkiConnect Android](https://github.com/KamWithK/AnkiconnectAndroid) for Anki integration.
