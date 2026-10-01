# Island

A Dynamic Island for GNOME Shell 50: one black pill at the top of the screen
for media, the time and notifications.

- **Media:** while something plays, the pill shows the cover, title and a
  little equalizer. Hover it (or click it) and it grows into a full player:
  album art, title, artist and album, a seekable progress bar, previous /
  play-pause / next, ±N second seek, shuffle, repeat and a switcher when
  several players are running. Middle-click the pill to play/pause.
- **Date and time:** placed inside the top bar, the pill always sits in place
  of GNOME's clock, showing just the date and time when nothing else is
  going on. Click them to open the calendar: a month view with your events
  for the selected day. Hit **+** to add an event (title, start/end time or
  all day) to your default calendar. Click the trash icon on an event to
  delete it.
- **Notifications:** incoming notifications open the island into a card with
  the app, title, message and action buttons, then shrink back after a few
  seconds. Click the card to open it; urgent ones stay until dismissed.
- **Blip transfers:** with [Blip](https://blip.net) installed, the island
  announces incoming files ("Receiving…" with progress and speed, then "File
  received" with Open / Show in folder) and the files you send. Click the send
  icon in the pill to pick one of your devices, then drop files on the window
  that opens, paste them with Ctrl+V (copied files, an image or text), or
  choose them. Needs Blip's desktop app to be started from its
  launcher, so its log reaches the journal.
- **Todo list:** click the list icon in the pill to add tasks, check them
  off or delete them. Stored locally in the extension's settings.

In the top bar it's always present. Placed below the top bar instead, it
hides when there is nothing to show.

<video src="assets/demo.mp4" controls muted loop width="100%"></video>


## Develop

```sh
make install        # symlink this folder into ~/.local/share/gnome-shell/extensions
make enable         # add it to the enabled list
```

On Wayland the running shell only notices new extensions after you log out and
back in. For quicker loops, run a nested shell in a window:

```sh
sudo dnf install mutter-devkit   # once
make nested
```

Other targets:

```sh
make mock ARGS='spotify "Some Song" "Some Artist"'   # fake player
make logs                                            # shell log, errors show here
make pack                                            # zip for extensions.gnome.org
gnome-extensions prefs island@k44z                   # settings window
```

## Default shortcuts

| Action | Keys |
| --- | --- |
| Expand / collapse | Super+Ctrl+M |
| Play / pause | Super+Ctrl+Space |
| Previous / next track | Super+Ctrl+, / Super+Ctrl+. |
| Seek back / forward | Super+Ctrl+← / Super+Ctrl+→ |
| Switch player | Super+Ctrl+P |
| Calendar | Super+Ctrl+C |
| Todo list | Super+Ctrl+T |

All of them can be changed in the settings window.
