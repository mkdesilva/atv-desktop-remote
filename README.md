# ATV Desktop Remote

A menubar app for controlling an Apple TV from your Mac.

![ATV Remote in light and dark mode](screenshot_new.png)

## Install

Download the latest `.dmg` from [Releases](https://github.com/mkdesilva/atv-desktop-remote/releases). Builds are signed and notarized, for Apple Silicon and Intel Macs.

This fork isn't on Homebrew. `brew install atv-remote` installs the [original project](https://github.com/bsharper/atv-desktop-remote), not this one.

## Usage

1. Click the remote icon in the menu bar, or press `Cmd+Shift+R` (or `Cmd+Ctrl+R`) from anywhere. Right-click the icon for more options.
2. The first time, pair with your Apple TV: pick it from the list, then type the 4-digit code shown on the TV. You can pair several and switch between them from the name in the top left.
3. If your Apple TV isn't listed, choose **Enter IP address…**. The TV shows its address under Settings → Network.
4. Every button has a key: arrows to move, Return to select, Esc or Delete to go back, Space to play/pause. Hold `Option` to see them all.
5. Hold a button for a second, or hold `Shift` with its key, for a long press.

<p align="center">
  <img src="buttonpress.gif" alt="Tapping and long-pressing buttons" width="200"/>
</p>

## Development

```sh
npm i --legacy-peer-deps
npm start
```

## Building and releasing

```sh
npm run build-arm   # Apple Silicon
npm run build       # Intel
npm run release     # both, then publish a GitHub release for the current version
```

Builds are signed with the Developer ID set in `package.json` and notarized with credentials from `electron-builder.env` (gitignored):

```
APPLE_ID=you@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=4TFEU94KP6
```

To cut a release, bump the version with `python3 fixversion.py <version>`, commit, then run `npm run release`.

## Credits

Forked from [bsharper/atv-desktop-remote](https://github.com/bsharper/atv-desktop-remote) by Brian Harper, who also wrote [atv-js](https://www.npmjs.com/package/@bharper/atv-js), the library this app uses to talk to the Apple TV. If you find it useful, consider [supporting him on Ko-fi](https://ko-fi.com/brianharper).
