import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PLACEMENTS = ['below-top-bar', 'top-bar'];

const SHORTCUTS = [
    ['toggle-island', () => _('Expand or collapse')],
    ['play-pause', () => _('Play / pause')],
    ['previous-track', () => _('Previous track')],
    ['next-track', () => _('Next track')],
    ['seek-backward', () => _('Seek backward')],
    ['seek-forward', () => _('Seek forward')],
    ['next-player', () => _('Switch player')],
];

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, title) {
        super({title, activatable: true});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset to default'),
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset(key));
        this.add_suffix(reset);

        this.connect('activated', () => this._capture());
        const id = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(id));
        this._sync();
    }

    _sync() {
        this._label.accelerator = this._settings.get_strv(this._key)[0] ?? '';
    }

    _capture() {
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: this.title,
            description: _('Press a new shortcut.\nEsc cancels, Backspace disables.'),
        });
        const dialog = new Adw.Dialog({
            title: _('Set Shortcut'),
            content_width: 360,
            child: new Adw.ToolbarView({content: status}),
        });
        dialog.child.add_top_bar(new Adw.HeaderBar());

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            const key = Gdk.keyval_to_lower(keyval);

            if (!mask && key === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && key === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (!mask || !Gtk.accelerator_valid(key, mask))
                return Gdk.EVENT_STOP;

            this._settings.set_strv(this._key, [Gtk.accelerator_name_with_keycode(null, key, keycode, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(this);
    }
});

export default class IslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({
            title: _('Island'),
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);

        const placement = new Adw.ComboRow({
            title: _('Placement'),
            subtitle: _('Inside the top bar, the island shows the time in place of the clock while media plays'),
            model: Gtk.StringList.new([_('Below the top bar'), _('Inside the top bar')]),
        });
        placement.selected = Math.max(0, PLACEMENTS.indexOf(settings.get_string('placement')));
        placement.connect('notify::selected', () =>
            settings.set_string('placement', PLACEMENTS[placement.selected]));
        behavior.add(placement);

        const clockLeft = new Adw.SwitchRow({
            title: _('Clock on the left'),
            subtitle: _('Move the date and time to the left side of the top bar'),
        });
        settings.bind('clock-left', clockLeft, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(clockLeft);

        const notifications = new Adw.SwitchRow({
            title: _('Notifications in the island'),
            subtitle: _('Show notifications in the island instead of GNOME’s banners'),
        });
        settings.bind('show-notifications', notifications, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(notifications);

        const hover = new Adw.SwitchRow({
            title: _('Expand on hover'),
            subtitle: _('Otherwise, click the island to expand it'),
        });
        settings.bind('expand-on-hover', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(hover);

        const hidePaused = new Adw.SwitchRow({
            title: _('Hide when paused'),
            subtitle: _('Fade out a few seconds after all players are paused'),
        });
        settings.bind('hide-when-paused', hidePaused, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(hidePaused);

        const seek = new Adw.SpinRow({
            title: _('Seek step'),
            subtitle: _('Seconds to skip backward or forward'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('seek-step', seek, 'value', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(seek);

        const shortcuts = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: _('Act on the player shown in the island'),
        });
        page.add(shortcuts);
        for (const [key, title] of SHORTCUTS)
            shortcuts.add(new ShortcutRow(settings, key, title()));
    }
}
