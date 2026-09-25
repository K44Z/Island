UUID     := island@k44z
EXT_DIR  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES  := mpris.js island.js art.js icons

.PHONY: schemas install uninstall enable pack nested mock logs

schemas:
	glib-compile-schemas --strict schemas/

install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR) $(EXT_DIR)

uninstall:
	rm -f $(EXT_DIR)

enable:
	gsettings set org.gnome.shell enabled-extensions \
	  "$$(gsettings get org.gnome.shell enabled-extensions | python3 -c 'import ast,sys; l=ast.literal_eval(sys.stdin.read().replace("@as ","")); l+=[] if "$(UUID)" in l else ["$(UUID)"]; print(l)')"

pack: schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist $(addprefix --extra-source=,$(SOURCES))

nested:
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session gnome-shell --devkit --wayland

mock:
	gjs -m tools/mock-player.js $(ARGS)

logs:
	journalctl -f -o cat /usr/bin/gnome-shell
